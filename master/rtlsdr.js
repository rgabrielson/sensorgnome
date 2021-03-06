/*
  implement a plan for an rtlsdr device

  This object represents a plugged-in rtlsdr device and associated plan.
  As soon as it is created, it begins applying the plan.  This means:
  - issuing VAH commands to start the device (on whatever schedule)
  - issuing shell commands to set device parameters (on whatever schedule)
  - respond to "devRemoved" messages by shutting down
  - respond to "devStalled" messages by and resetting + restarting the
    device

  Most of the work is done by a modified version of rtl_tcp, to which
  we establish two half-duplex connections.  rtl_tcp listens to the
  first for commands to start/stop streaming and set tuning and
  filtering parameters.  rtl_tcp sends streamed samples down the
  second connection.  The first connection is from nodejs, running
  this module.  Commands are sent to that connection, and it replies
  with a JSON-formatted list of current parameter settings.

  The second connection is opened by vamp-alsa-host, after we ask it
  to "open" the rtlsdr device.  We watch for the death of vamp-alsa-host
  in which case we need to restart rtl_tcp, since its only handles
  two connections and dies after noticing either has closed.

  Parameters settings accepted by rtl_tcp are all integers; this module
  is responsible for converting to/from natural units.
  example:

    parameter    rtl_tcp unit    "natural unit"
                   (integer)    (floating point)
   ---------------------------------------------
    frequency     166370000        166.376 MHz
    tuner_gain       105             10.5 dB

  "Natural units" are used in deployment.txt, the web interface, and
  the matron's "setParam" messages.

*/

RTLSDR = function(matron, dev, devPlan) {
    Sensor.Sensor.call(this, matron, dev, devPlan);
    // path to the socket that rtl_tcp will use
    // e.g. /tmp/rtlsdr-1:4.sock for a device with usb path 1:4 (bus:dev)
    this.sockPath = "/tmp/rtlsdr-" + dev.attr.usbPath + ".sock";
    // path to rtl_tcp
    this.prog = "/usr/bin/rtl_tcp";

    // hardware rate needed to achieve plan rate;
    // same algorithm as used in vamp-alsa-host/RTLSDRMinder::getHWRateForRate
    // i.e. find the smallest exact multiple of the desired rate that is in
    // the allowed range of hardware rates.

    var rate = devPlan.plan.rate;
    if (rate <= 0 || rate > 3200000) {
console.log("rtlsdr: requested rate not within hardware range; using 48000");
        rate = 48000;
    }

    this.hw_rate = rate;
    for(;;) {
        if ((this.hw_rate >= 225001 && this.hw_rate <= 300000) || (this.hw_rate >= 900001 && this.hw_rate <= 3200000))
            break;
        this.hw_rate += rate;
    }

    // callback closures
    this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    this.this_logServerError   = this.logServerError.bind(this);
    this.this_VAHdied          = this.VAHdied.bind(this);
    this.this_serverDied       = this.serverDied.bind(this);
    this.this_serverError      = this.serverError.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    this.this_cmdSockError     = this.cmdSockError.bind(this);
    this.this_cmdSockClose     = this.cmdSockClose.bind(this);
    this.this_cmdSockEnd       = this.cmdSockEnd.bind(this);
    this.this_spawnServer      = this.spawnServer.bind(this);

    // handle situation where program owning other connection to rtl_tcp dies
    this.matron.on("VAHdied", this.this_VAHdied);

    // storage for the setting list sent by rtl_tcp
    this.replyBuf = ""; // buffer the reply stream, in case it crosses transmission unit boundaries

    // rtl_tcp replies with a 12-byte header, before real command replies; we ignore this
    // as the info is available elsewhere
    this.gotCmdHeader = false;

    this.inDieHandler = false; // when true, the device's death is already being handled

    this.killing = false; // when true, we've deliberately killed the server
};

RTLSDR.prototype = Object.create(Sensor.Sensor.prototype);
RTLSDR.prototype.constructor = RTLSDR;

RTLSDR.prototype.rtltcpCmds = {
    // table of command recognized by rtl_tcp
    //
    // - the command is sent as a byte, followed by a big-endian 32-bit parameter
    //
    // - units for parameters below are those understood by rtl_tcp, and are integers
    //
    // - parameters have the same name in deployment.txt, but some of the units
    //   differ there, since they are allowed to be reals.

    frequency:          1, // listening frequency;  units: Hz; (deployment.txt units: MHz)
    rate:               2, // sampling rate, in Hz
    gain_mode:          3, // whether or not to allow gains to be set (0 = no, 1 = yes)
    tuner_gain:         4, // units: 0.1 dB (deployment.txt units: dB); closest available tuner gain is selected
    freq_correction:    5, // in units of ppm; we don't use this

    // gains for IF stages are sent using the same command; the stage # is encoded in the upper 16 bits of the 32-bit parameter
    if_gain1:           6, // IF stage 1 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain2:           6, // IF stage 2 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain3:           6, // IF stage 3 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain4:           6, // IF stage 4 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain5:           6, // IF stage 5 gain; units: 0.1 dB (deployment.txt units: dB)
    if_gain6:           6, // IF stage 6 gain; units: 0.1 dB (deployment.txt units: dB)

    test_mode:          7, // send counter instead of real data, for testing (0 = no, 1 = yes)
    agc_mode:           8, // automatic gain control (0 = no, 1 = yes); not sure which gain stages are affected
    direct_sampling:    9, // sample RF directly, rather than IF stage; 0 = no, 1 = yes (not for radio frequencies above 10 MHz)
    offset_tuning:     10, // detune away from exact carrier frequency, to avoid deadzone in some tuners; 0 = no, 1 = yes
    rtl_xtal:          11, // set use of crystal built into rtl8232 chip? (vs off-chip tuner); 0 = no, 1 = yes
    tuner_xtal:        12, // set use of crystal on tuner (vs off-board tuner); 0 = no, 1 = yes
    tuner_gain_index:  13, // tuner gain setting by index into array of possible values; array size is returned when first connecting to rtl_tcp
    streaming:         14  // have rtl_tcp start (1) or stop (0) submitting URBs and sending sample data to other connection
};

RTLSDR.prototype.hw_devPath = function() {

    // the device path parsable by vamp-alsa-host/RTLMinder;
    // it looks like rtlsdr:/tmp/rtlsdr-1:4.sock

    return "rtlsdr:" + this.sockPath;
};

RTLSDR.prototype.hw_init = function(callback) {
// DEBUG: console.log("calling hw_init on rtlsdr");
    this.initCallback = callback;
    this.spawnServer();   // launch the rtl_tcp process
};

RTLSDR.prototype.spawnServer = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
// DEBUG: console.log("about to delete command socket with path: " + this.sockPath + "\n");
    try {
        // Note: node throws on this call if this.sockPath doesn't exist;
        Fs.unlinkSync(this.sockPath);
    } catch (e)
    {
// DEBUG: console.log("Error removing command socket: " + e.toString() + "\n");
    };

    // set the libusb buffer size so it holds approximately 100 ms of I/Q data
    // We round up to the nearest multiple of 512 bytes, as required by libusb

    var usb_buffer_size = this.hw_rate * 2 * 0.100;
    usb_buffer_size = 512 * Math.ceil(usb_buffer_size / 512.0);

    var args = ["-p", this.sockPath, "-d", this.dev.attr.usbPath, "-s", this.hw_rate, "-B", usb_buffer_size];
// DEBUG: console.log("RTLSDR about to spawn server with options: " + JSON.stringify(args) + "\n");
    var server = ChildProcess.spawn(this.prog, args);
    server.on("exit", this.this_serverDied);
    server.on("error", this.this_serverError);
    server.stdout.on("data", this.this_serverReady);
    server.stderr.on("data", this.this_logServerError);
    this.server = server;
};

RTLSDR.prototype.serverReady = function(data) {
    if (this.inDieHandler)
        return;
    if (data.toString().match(/Listening/)) {
        if(this.server) {
            this.server.stdout.removeListener("data", this.this_serverReady);
            this.connectCmd();
        }
    }
};

RTLSDR.prototype.connectCmd = function() {
    // server is listening for connections, so connect
// DEBUG: console.log("RTLSDR connected to server\n");
    if (this.cmdSock || this.inDieHandler) {
        return;
    }
// DEBUG: console.log("about to connect command socket with path: " + this.sockPath + "\n");
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("close" , this.this_cmdSockClose);
    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

RTLSDR.prototype.cmdSockError = function(e) {
// DEBUG: console.log("Got command socket error, e=0\n");
    if (! e)
        return;
// DEBUG: console.log("Got command socket error " + e.toString() + "\n");
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

RTLSDR.prototype.cmdSockEnd = function(e) {
// DEBUG: console.log("Got command socket end, e=0\n");
    if (! e)
        return;
// DEBUG: console.log("Got command socket end " + e.toString() + "\n");
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

RTLSDR.prototype.cmdSockClose = function(e) {
    if (!e )
        return;
// DEBUG: console.log("Got command socket close " + e.toString() + "\n");
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

RTLSDR.prototype.cmdSockConnected = function() {
    // process any queued command
// DEBUG: console.log("Got command socket connected\n");
    if (this.initCallback) {
        var cb = this.initCallback;
        this.initCallback = null;
        cb();
    }
};

RTLSDR.prototype.VAHdied = function() {
    this.hw_delete();
};

RTLSDR.prototype.serverError = function(err) {
// DEBUG: console.log("rtl_tcp server got error:\n" + JSON.stringify(err) + "\n")
};

RTLSDR.prototype.serverDied = function(code, signal) {
    if (this.killing)
        return;
// DEBUG: console.log("rtl_tcp server died\ncode: " + code + "\nsignal:" + signal + "\n")
    this.hw_reset();
};

RTLSDR.prototype.hw_delete = function() {
// DEBUG: console.log("rtlsdr::hw_delete\n");
    if (this.server) {
        this.killing = true;
        this.server.kill("SIGKILL");
        this.server = null;
    }
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
};

RTLSDR.prototype.hw_startStop = function(on) {
    // just send the 'streaming' command with appropriate value
    this.hw_setParam({par:"streaming", val:on});
// DEBUG: console.log("rtlsdr::hw_startStop = " + on + "\n");
};

// hw_reset is called when either data from the device seems to have stalled
// (which can be due to chrony stepping the clock forward) or when rtl_tcp
// has died

RTLSDR.prototype.hw_reset = function() {
    if (this.inDieHandler)
        return;
    this.inDieHandler = true;
    // pretend the device has been removed then added
// DEBUG: console.log("rtlsdr::hw_reset\n");
    // copy the device structure (really - this is the best node has to offer for cloning POD?)
    var dev = JSON.parse(JSON.stringify(this.dev));
    // re-add after 5 seconds
    setTimeout(function(){TheMatron.emit("devAdded", dev)}, 5000);
    // remove now
    this.matron.emit("devRemoved", this.dev);
};

RTLSDR.prototype.hw_stalled = function() {
    // relaunch rtl_tcp and re-establish connection
// DEBUG: console.log("rtlsdr::hw_stalled\n");
    this.hw_reset();
};

RTLSDR.prototype.hw_setParam = function(parSetting, callback) {
    // create the 5-byte command and send it to the socket
    var cmdBuf = new Buffer(5);
    var par = parSetting.par, val = parSetting.val;

    // fix up any parameter values to match rtl_tcp semantics

    switch (par) {
    case "frequency":
        // convert from MHz to Hz
        val = Math.round(val * 1.0E6);
        break;
    case "tuner_gain":
        // convert from dB to 0.1 dB
        val = Math.round(val * 10);
        break;
    case "if_gain1":
    case "if_gain2":
    case "if_gain3":
    case "if_gain4":
    case "if_gain5":
    case "if_gain6":
        // encode gain stage in upper 16 bits of value, convert dB to 0.1 dB in lower 16 bits
        val = par.substr(7) << 16 + Math.round(val * 10);
        break;
    }
    var cmdNo = this.rtltcpCmds[parSetting.par];
    if (cmdNo && this.cmdSock) {
// DEBUG: console.log("RTLSDR: about to set parameter " + par + " to " + val + "\n");
        try {
            cmdBuf.writeUInt8(cmdNo, 0);
            cmdBuf.writeUInt32BE(val, 1); // note: rtl_tcp expects big-endian
            this.cmdSock.write(cmdBuf, callback);
        } catch(e) {
            this.matron.emit("setParamError", {type:"rtlsdr", port: this.dev.attr.port, par: par, val:val, err: e.toString()})
        }
    };
};

RTLSDR.prototype.logServerError = function(data) {
    console.log("rtl_tcp got error: " + data.toString() + "\n");
};

RTLSDR.prototype.gotCmdReply = function(data) {

    // rtl_tcp command replies are single JSON-formatted objects on a
    // single line ending with '\n'.  Although the reply should fit in
    // a single transmission unit, and so be completely contained in
    // the 'data' parameter from a single call to this function, we
    // play it safe and treat the replies as a '\n'-delimited stream
    // of JSON strings, parsing each complete string into
    // this.dev.settings

    // skip the 12 byte header
    this.replyBuf += data.toString('utf8', this.gotCmdHeader ? 0 : 12);
    this.gotCmdHeader = true;
    for(;;) {
	var eol = this.replyBuf.indexOf("\n");
	if (eol < 0)
	    break;
        var replyString = this.replyBuf.substring(0, eol);
	this.replyBuf = this.replyBuf.substring(eol + 1);
        var dev = HubMan.getDevs()[this.dev.attr.port];
        if (dev) {
            dev.settings = JSON.parse(replyString);
            for (p in dev.settings) {
                var val = dev.settings[p];
                switch (p) {
                case "frequency":
                    // convert to MHz from Hz
                    val = val / 1.0E6;
                    break;
                case "tuner_gain":
                case "if_gain1":
                case "if_gain2":
                case "if_gain3":
                case "if_gain4":
                case "if_gain5":
                case "if_gain6":
                    // convert to dB from 0.1 dB
                    val = val / 10.0;
                    break;
                };
                dev.settings[p] = val;
            }
        }
    }
};

exports.RTLSDR = RTLSDR;
