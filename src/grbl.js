// See https://github.com/gnea/grbl

const SerialPort = require('./serial');
const { ERROR_CODES } = require('./errors');

const BAUD_RATE = 115200;

// Other versions may work but are untested
const SUPPORTED_VERSION = '1.1h';

// See config.h
const CMD_RESET = 0x18; // ctrl-x.
const CMD_STATUS_REPORT = '?';
const CMD_CYCLE_START = '~';
const CMD_FEED_HOLD = '!';

function parseRTStatus(msg) {
  // Example message:
  // <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>

  if (!msg.startsWith('<') || !msg.endsWith('>')) {
    throw new Error(`Invalid RT status message: ${msg}`);
  }

  // Strip the angle brackets and split by pipes
  const parts = msg.slice(1, -1).split('|');

  return parts.reduce((result, part) => {
    const [key, rawValue] = part.split(':');

    // If value exists, split it by commas, otherwise set an empty array
    const value = rawValue ? rawValue.split(',').map((val) => {
      // Try converting to float, if not possible, keep original value
      const floatVal = parseFloat(val);
      return Number.isNaN(floatVal) ? val : floatVal;
    }) : [];

    return {
      ...result,
      [key]: value,
    };
  }, {});
}

class GrblController {
  constructor() {
    this.port = new SerialPort();

    this.version = undefined;
    this.pending = [];
    this.responseHandlers = [];
    this.connected = false;

    this.port.on('line', (line) => {
      if (this.responseHandlers.length === 0) {
        console.log(`Received unexpected message from Grbl: ${line}`);
        return;
      }

      const handleResponse = this.responseHandlers.shift();
      handleResponse(line);
    });
  }

  async connect() {
    if (this.connected) {
      return Promise.resolve();
    }

    await this.port.connect(BAUD_RATE);

    // Handle the welcome message that is received when the connection is opened
    // Raise an exception if the version is different from what we expect
    return new Promise((resolve) => {
      let welcomeBuffer = '';

      const welcomeHandler = (line) => {
        welcomeBuffer += line;

        if (welcomeBuffer.endsWith("['$' for help]")) {
          const welcomeMessageRegex = /Grbl (\d+\.\d+[a-z]?) \['\$' for help]/;
          const match = welcomeBuffer.match(welcomeMessageRegex);

          if (match) {
            [, this.version] = match;

            if (this.version !== SUPPORTED_VERSION) {
              throw new Error(`Unsupported Grbl version: ${this.version}`);
            }

            resolve();
          } else {
            throw new Error('Could not parse Grbl welcome message');
          }

          return;
        }

        this.responseHandlers.push(welcomeHandler);
      };

      this.responseHandlers.push(welcomeHandler);
    });
  }

  command(cmd, numResponseLines = 1, timeout = 3000) {
    const responsePromise = new Promise((fulfill, reject) => {
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Command "${cmd}" timed out`));
      }, timeout);

      const lines = [];

      for (let i = 0; i < numResponseLines; i += 1) {
        // eslint-disable-next-line no-loop-func
        this.responseHandlers.push((line) => {
          if (timedOut) {
            return;
          }

          lines.push(line);

          if (lines.length === numResponseLines) {
            clearTimeout(timeoutId);
            fulfill(lines.join('\r\n'));
          }
        });
      }
    });

    return new Promise((fulfill) => {
      const executeCommand = () => this.port.print(`${cmd}\r`)
        .then(() => responsePromise)
        .then((response) => {
          fulfill(response);

          // Remove ourselves from the pending queue
          this.pending.shift();

          // Execute the next command if there is one
          if (this.pending.length > 0) {
            this.pending[0]().then();
          }
        });

      const othersPending = this.pending.length > 0;
      this.pending.push(executeCommand);

      if (!othersPending) {
        executeCommand().then();
      }
    });
  }

  // Grbl API
  // See https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands

  // $ Commands

  // TODO: $$ and $x=val - View and write Grbl settings
  // TODO: $# - View gcode parameters
  // TODO: $G - View parser state
  // TODO: $I - View build info
  // TODO: $N - View startup blocks
  // TODO: $Nx=line - Save startup block
  // TODO: $C - Check gcode mode
  // TODO: $X - Kill alarm lock
  // TODO: $H - Run homing cycle

  /**
   * Send a command directly to Grbl.
   * @param command - The command to send
   * @returns {Promise<void>} - Resolves when the command has been acknowledged
   */
  async send(command) {
    const response = await this.command(command);

    if (response === 'ok') {
      return;
    }

    if (response.startsWith('error:')) {
      const errorCode = parseInt(response.slice(6), 10);

      if (errorCode in ERROR_CODES) {
        throw new Error(`Grbl error: ${ERROR_CODES[errorCode]}`);
      } else {
        throw new Error(`Unknown Grbl error code: ${errorCode}`);
      }
    }

    throw new Error(`Unexpected response to jog command: ${response}`);
  }

  /**
   * Run a jogging command.
   * See {@link https://github.com/gnea/grbl/wiki/Grbl-v1.1-Jogging}
   * @param command - Requires: One or more XYZ words, and a feed rate word.
   * Optional: G20/G21, G90/G91, G53. For example, G91 G20 X0.5 F10.
   * @returns {Promise<void>} - Resolves when the command has been acknowledged
   */
  async jog(command) {
    // TODO: handle soft limits error
    return this.send(`$J=${command}`);
  }

  // TODO: $RST=$, $RST=#, and $RST=* - Restore Grbl settings and data to defaults
  // TODO: $SLP - Enable Sleep Mode

  // Real-time commands

  /**
   * Performs a status report query
   * See the function report_realtime_status in grbl/report.c
   * https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/report.c#L466
   * @returns {Promise<void>}
   */
  async rtQueryStatus() {
    const response = await this.command(CMD_STATUS_REPORT, 2);

    // Status then ok
    const [statusStr] = response.split('\r\n');

    return parseRTStatus(statusStr);
  }

  // TODO: CMD_RESET
  // TODO: CMD_CYCLE_START
  // TODO: CMD_FEED_HOLD

  // Extended real-time commands
  // https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands#extended-ascii-realtime-command-descriptions
  // TODO: 0x84 : Safety Door
  // TODO: 0x85 : Jog Cancel
  // TODO: Feed Overrides
  //  0x90 : Set 100% of programmed rate.
  //  0x91 : Increase 10%
  //  0x92 : Decrease 10%
  //  0x93 : Increase 1%
  //  0x94 : Decrease 1%
  // TODO: Rapid Overrides
  //  0x95 : Set to 100% full rapid rate.
  //  0x96 : Set to 50% of rapid rate.
  //  0x97 : Set to 25% of rapid rate.
  // TODO: Spindle Speed Overrides
  //  0x99 : Set to 100% of programmed speed.
  //  0x9A : Increase 10%
  //  0x9B : Decrease 10%
  //  0x9C : Increase 1%
  //  0x9D : Decrease 1%
  // TODO: Toggle Spindle Stop
  // TODO: Toggle Flood Coolant
  // TODO: Toggle Mist Coolant

  disconnect() {
    return this.port.disconnect();
  }
}

module.exports = {
  GrblController,
  parseRTStatus,
  ERROR_CODES,
};
