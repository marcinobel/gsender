// The server logger cannot be loaded under jest: jest.config.js maps
// `config/settings` to the app-side mock, so `settings.winston.level` throws at
// module scope in src/server/lib/logger.js. The mock also gives AC5 an
// assertion target (`logger.__entry.error`).
jest.mock('../../../lib/logger', () => {
    const entry = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        verbose: jest.fn(),
        debug: jest.fn(),
        silly: jest.fn(),
    };
    const logger = () => entry;
    logger.__entry = entry;
    return {
        __esModule: true,
        default: logger,
        levels: [],
        getLevel: () => 'error',
        setLevel: () => {},
    };
});

// `shortid` (via services/taskrunner) pulls in nanoid's ESM browser build,
// which babel-jest does not transform (node_modules is ignored).
jest.mock('shortid', () => ({
    __esModule: true,
    default: { generate: () => 'test-id' },
    generate: () => 'test-id',
}));

import fs from 'fs';
import path from 'path';
import logger from '../../../lib/logger';
import GrblController from '../GrblController';

const SOURCE_PATH = path.join(__dirname, '..', 'GrblController.js');

const makeConnection = () => ({
    isOpen: false,
    setWriteFilter: jest.fn(),
    write: jest.fn(),
    writeImmediate: jest.fn(),
    isNetwork: () => false,
    // GrblController.emit() delegates here; gcode:load -> workflow.stop() emits.
    emitToSockets: jest.fn(),
});

describe('GrblController - %wait planner drain', () => {
    let controller;
    let connection;
    let consoleLog;

    beforeAll(() => {
        // src/server/lib/evaluate-expression.js dumps every visited AST node to
        // stdout; keep the test output readable.
        consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterAll(() => {
        consoleLog.mockRestore();
    });

    beforeEach(() => {
        connection = makeConnection();
        controller = new GrblController({}, connection, {
            port: '/dev/null',
            baudrate: 115200,
        });
        // populateContext() destructures this.settings.settings
        controller.settings = { settings: {} };
    });

    afterEach(() => {
        controller.destroy(); // clears the 250 ms queryTimer
        jest.clearAllMocks();
    });

    describe('gcode:load (AC1, AC6)', () => {
        beforeEach(() => {
            controller.command(
                'gcode:load',
                { name: 'job' },
                'G21\nG0 X1\nG0 X2',
            );
        });

        it('T1: appends the bare %wait token as the last line', () => {
            const { lines } = controller.sender.state;
            expect(lines[lines.length - 1]).toBe('%wait');
        });

        it('T2: does not disturb line accounting', () => {
            const { total, sent, received, lines } = controller.sender.state;
            expect(total).toBe(4);
            expect(lines).toEqual(['G21', 'G0 X1', 'G0 X2', '%wait']);
            expect(sent).toBe(0);
            expect(received).toBe(0);
        });
    });

    describe('dataFilter - %wait recognition', () => {
        const expectDrain = (result) => {
            expect(result).toBe('G4 P0.5');
            expect(controller.sender.state.hold).toBe(true);
            expect(controller.sender.state.holdReason).toEqual({
                data: '%wait',
            });
        };

        it('T3: holds and dwells on a bare %wait (AC2)', () => {
            expectDrain(controller.sender.dataFilter('%wait', {}));
        });

        it('T4: holds and dwells on %wait carrying the appended comment (AC3)', () => {
            expectDrain(
                controller.sender.dataFilter(
                    '%wait ; Wait for the planner to empty',
                    {},
                ),
            );
        });

        it('T5: holds and dwells regardless of spacing before the comment (AC3)', () => {
            expectDrain(controller.sender.dataFilter('%wait;x', {}));
            controller.sender.unhold();
            expectDrain(controller.sender.dataFilter('%wait   ; x', {}));
        });
    });

    it('T6: leaves a % expression byte-identical for the evaluator (AC4)', () => {
        const result = controller.sender.dataFilter(
            '%global.width = Number(xmax) || 0',
            { xmax: 42 },
        );

        expect(result).toBe('');
        // A bracket-stripped `Number || 0` would assign the Number function.
        expect(controller.sharedContext.width).toBe(42);
    });

    it('T6b: hands the evaluator a `;` inside a string literal untruncated (AC4)', () => {
        // The comparison copy is lossy here — stripSemicolonComment() returns
        // '%global.msg = "a' (see S9), which esprima cannot parse. This is the
        // case the throwaway-copy design exists for: only `token` may be
        // truncated, never the line that reaches evaluateAssignmentExpression.
        const result = controller.sender.dataFilter(
            '%global.msg = "a;b"',
            {},
        );

        expect(result).toBe('');
        expect(controller.sharedContext.msg).toBe('a;b');
    });

    it('T7: logs no evaluator error for a clean program load (AC5)', () => {
        controller.command(
            'gcode:load',
            { name: 'job' },
            'G21\nG0 X1\n%global.width = Number(xmax) || 0\nG0 X2',
        );

        logger.__entry.error.mockClear();
        for (const line of controller.sender.state.lines) {
            controller.sender.dataFilter(line, {});
        }

        expect(logger.__entry.error).not.toHaveBeenCalled();
    });

    it('T8: drops a comment-only % line without an evaluator error (AC5)', () => {
        logger.__entry.error.mockClear();

        expect(controller.sender.dataFilter('%; a comment line', {})).toBe('');
        expect(logger.__entry.error).not.toHaveBeenCalled();
    });

    it('T9: releases the hold when the controller acks the dwell', () => {
        controller.workflow.start();
        expect(controller.sender.dataFilter('%wait', {})).toBe('G4 P0.5');
        expect(controller.sender.state.hold).toBe(true);

        controller.runner.emit('ok', { raw: 'ok' });

        expect(controller.sender.state.hold).toBe(false);
    });

    it('T10: declares the %wait literal exactly once, never with a comment baked in (AC8)', () => {
        const source = fs.readFileSync(SOURCE_PATH, 'utf8');
        // Defensive: the count below only matches a *quoted* token, and no
        // `//` comment in GrblController.js quotes it today, so this strip is
        // currently a no-op. It exists so that prose which does quote the
        // token later is not miscounted as a second declaration. Known limit:
        // it only removes whole-line `//` comments — a trailing `// ...` or a
        // `/* ... */` block that quotes the token would still be counted.
        const code = source.replace(/^[ \t]*\/\/.*$/gm, '');
        const matches = code.match(/['"]%wait['"]/g) || [];

        // One `const WAIT = "%wait"` - the dataFilter comparison and the
        // gcode:load dwell must both read that constant, never re-inline it.
        expect(matches).toHaveLength(1);
        // The defect itself: a literal of the form "%wait ; ..." is not caught
        // by the count above, because the closing quote does not follow %wait.
        expect(source).not.toMatch(/['"]%wait\s*;/);
    });
});
