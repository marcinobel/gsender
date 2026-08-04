// See the sibling Grbl suite: the server logger cannot be loaded under jest
// (jest.config.js maps `config/settings` to the app-side mock), and `shortid`
// pulls in nanoid's untransformed ESM browser build.
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

jest.mock('shortid', () => ({
    __esModule: true,
    default: { generate: () => 'test-id' },
    generate: () => 'test-id',
}));

import fs from 'fs';
import path from 'path';
import GrblHalController from '../GrblHalController';

const SOURCE_PATH = path.join(__dirname, '..', 'GrblHalController.js');

const makeConnection = () => ({
    isOpen: false,
    setWriteFilter: jest.fn(),
    write: jest.fn(),
    writeImmediate: jest.fn(),
    isNetwork: () => false,
    emitToSockets: jest.fn(),
});

describe('GrblHalController - %wait handling', () => {
    let controller;
    let connection;
    let consoleLog;

    beforeAll(() => {
        consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterAll(() => {
        consoleLog.mockRestore();
    });

    beforeEach(() => {
        connection = makeConnection();
        controller = new GrblHalController({}, connection, {
            port: '/dev/null',
            baudrate: 115200,
        });
        controller.settings = { settings: {} };
    });

    afterEach(() => {
        controller.destroy();
        jest.clearAllMocks();
    });

    it('H1: does not append a dwell on gcode:load (AC7)', () => {
        // grblHAL takes `name` as a string; Grbl takes a { name } object.
        controller.command('gcode:load', 'job', 'G21\nG0 X1\nG0 X2');

        const { lines, total } = controller.sender.state;
        expect(lines).toEqual(['G21', 'G0 X1', 'G0 X2']);
        expect(lines[lines.length - 1]).toBe('G0 X2');
        expect(total).toBe(3);
        expect(lines).not.toContain('%wait');
    });

    it('H2: still recognises a commented %wait from any other source (AC2/AC3)', () => {
        expect(controller.sender.dataFilter('%wait ; drain', {})).toBe(
            'G4 P0.5',
        );
        expect(controller.sender.state.hold).toBe(true);
        expect(controller.sender.state.holdReason).toEqual({ data: '%wait' });
    });

    it('H3: leaves a % expression byte-identical for the evaluator (AC4)', () => {
        const result = controller.sender.dataFilter(
            '%global.width = Number(xmax) || 0',
            { xmax: 42 },
        );

        expect(result).toBe('');
        expect(controller.sharedContext.width).toBe(42);
    });

    it('H3b: hands the evaluator a `;` inside a string literal untruncated (AC4)', () => {
        // See the sibling Grbl case: the comparison copy truncates at the `;`
        // (S9), so this pins that the untruncated line is what gets evaluated.
        const result = controller.sender.dataFilter('%global.msg = "a;b"', {});

        expect(result).toBe('');
        expect(controller.sharedContext.msg).toBe('a;b');
    });

    it('H5: releases the hold when the controller acks the dwell', () => {
        // Sibling of the Grbl suite's T9, and the reason it matters here: this
        // controller appends no dwell of its own (H1), but H2 means a commented
        // `%wait` in a user's job file now holds the sender on grblHAL too. A
        // hold that is never released leaves the job wedged at "running" with
        // no error, so pin the release, not just the hold.
        controller.workflow.start();
        expect(controller.sender.dataFilter('%wait', {})).toBe('G4 P0.5');
        expect(controller.sender.state.hold).toBe(true);

        controller.runner.emit('ok', { raw: 'ok' });

        expect(controller.sender.state.hold).toBe(false);
    });

    it('H4: declares the %wait literal exactly once, never with a comment baked in (AC8)', () => {
        const source = fs.readFileSync(SOURCE_PATH, 'utf8');
        // Defensive: the count below only matches a *quoted* token. The `//`
        // block in gcode:load that explains why this controller sends no dwell
        // is prose and never writes the token, so this strip is currently a
        // no-op. It exists so that prose which does quote the token later is
        // not miscounted as a second declaration. Known limit: it only removes
        // whole-line `//` comments — a trailing `// ...` or a `/* ... */` block
        // that quotes the token would still be counted.
        const code = source.replace(/^[ \t]*\/\/.*$/gm, '');
        const matches = code.match(/['"]%wait['"]/g) || [];

        expect(matches).toHaveLength(1);
        // Applies to the whole file, comments included: if the dwell is ever
        // re-enabled here it must be the bare token, not a token plus a `;`
        // comment.
        expect(source).not.toMatch(/['"]%wait\s*;/);
    });
});
