import { stripSemicolonComment } from '../strip-semicolon-comment';

describe('stripSemicolonComment', () => {
    it('S1: leaves a line with no comment unchanged', () => {
        expect(stripSemicolonComment('%wait')).toBe('%wait');
    });

    it('S2: removes a `;` comment and the whitespace in front of it', () => {
        expect(
            stripSemicolonComment('%wait ; Wait for the planner to empty'),
        ).toBe('%wait');
    });

    it('S3: removes a `;` comment with no space before it', () => {
        expect(stripSemicolonComment('%wait;drain')).toBe('%wait');
    });

    it('S4: leaves parentheses in a % expression intact', () => {
        const line = '%global.tool = Number(tool) || 0';
        expect(stripSemicolonComment(line)).toBe(line);
    });

    it('S5: leaves commas and nested calls in a % sequence expression intact', () => {
        const line =
            '%prevTool = Number(global.tool) || 0, global.tool = tool';
        expect(stripSemicolonComment(line)).toBe(line);
    });

    it('S6: reduces a comment-only % line to the bare `%`', () => {
        expect(stripSemicolonComment('%; note')).toBe('%');
    });

    it('S7: strips a comment from a plain G-code line', () => {
        expect(stripSemicolonComment('G0 X1 ; move')).toBe('G0 X1');
    });

    it('S8: trims surrounding whitespace', () => {
        expect(stripSemicolonComment('  %wait  ')).toBe('%wait');
    });

    it('S8b: trims a trailing CR from a CRLF file', () => {
        // A trailing character the `===` comparison rejects is the bug class
        // this whole change is about, so pin the CRLF case separately from S8
        // rather than folding it in: a plain-space regression and a line-ending
        // regression are different failures and should read as different tests.
        expect(stripSemicolonComment('%wait\r')).toBe('%wait');
    });

    it('S9: truncates at a `;` inside a string literal (documented lossiness)', () => {
        // The helper is a token comparator, not a parser: it cannot tell a
        // comment `;` from one inside a quoted string, and the result below is
        // not valid JavaScript. This is why callers must keep the original
        // line for the evaluator and use this output only for comparison.
        // GrblController/GrblHalController pin the other half of that contract.
        expect(stripSemicolonComment('%global.msg = "a;b"')).toBe(
            '%global.msg = "a',
        );
    });

    // S10/S11 pin the CWE-1333 payload from the SEC-001 audit: a `%` line
    // carrying a long whitespace run. They assert output only — a wall-clock
    // assertion would be flaky on shared CI — but a regex that reintroduces the
    // leading `\s*` makes S10 quadratic, which shows up in the suite timings.
    //
    // Reachability differs between the two, and only S11 is reachable through
    // today's callers:
    //
    //   S10 is a helper-*contract* test. Both `%` call sites are fed lines that
    //   Sender.js already trimmed (Sender.js:213 and :249 both do
    //   `.trim()` before dataFilter runs), so a trailing whitespace run arrives
    //   here as a bare '%'. It is pinned because the helper is exported and a
    //   future caller need not pre-trim — and because it is the payload that
    //   actually triggers the backtracking: with no `;` to end the greedy run,
    //   `/\s*;.*/` retries from every position in it.
    //
    //   S11 is the reachable one: the whitespace is *interior*, between the
    //   token and its comment, so `.trim()` cannot remove it. (This shape stays
    //   fast even under the old regex — the `;` ends the greedy match on the
    //   first try — so it pins output, not timing.)
    //
    // 20 000 is deliberate: enough to be unmistakable (the leading-`\s*` regex
    // measured ~200 ms here versus ~0.06 ms fixed), small enough to leave a
    // wide margin under jest's 5 s default timeout. 100 000 took ~4.4 s, about
    // a second from failing on a loaded CI box.
    const LONG_RUN = ' '.repeat(20000);

    it('S10: reduces a % line followed by a long whitespace run to the bare `%`', () => {
        expect(stripSemicolonComment(`%${LONG_RUN}`)).toBe('%');
    });

    it('S11: strips a comment sitting behind a long whitespace run', () => {
        expect(stripSemicolonComment(`%wait${LONG_RUN}; drain`)).toBe('%wait');
    });
});
