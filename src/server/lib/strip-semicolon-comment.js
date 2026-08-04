/*
 * Copyright (C) 2021 Sienci Labs Inc.
 *
 * This file is part of gSender.
 *
 * gSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, under version 3 of the License.
 *
 * gSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gSender.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Contact for information regarding this program and its license
 * can be sent through gSender@sienci.com or mailed to the main office
 * of Sienci Labs Inc. in Waterloo, Ontario, Canada.
 *
 */

// A `;` line comment, from the `;` to end-of-line. No leading `\s*`: it made the
// match Θ(n²) on a long whitespace run containing no `;` (CWE-1333), and the
// `.trim()` below removes that whitespace anyway. Deliberately not global: on a
// single line the first match already runs to end-of-line, and a module-level
// /g regex carries lastIndex state that is easy to misuse later.
const SEMICOLON_COMMENT = /;.*/;

/**
 * Removes a trailing `;` line comment from a single line.
 *
 * Handles the `;` comment form **only**. G-code's other comment form,
 * parentheses, is not touched — callers that need it strip it themselves with
 * their own `bracketCommentLine` regex.
 *
 * Intended for *comparing* a line against the `%` command tokens (`%wait`,
 * `%pause_start`, …) without mutating the line. A `%` line is a JavaScript
 * expression, where parentheses and commas are syntax rather than G-code
 * comments, so callers must keep the original line for the evaluator and use
 * this result only for the comparison.
 *
 * The `;` is taken literally, so a `;` inside a string literal truncates the
 * result. That is safe for token comparison — and only for token comparison:
 *
 *   '%wait'                     → '%wait'
 *   '%wait ; drain the planner' → '%wait'
 *   '%; note'                   → '%'
 *   'G0 X1 ; move'              → 'G0 X1'
 *   '%global.msg = "a;b"'       → '%global.msg = "a'   (lossy, never evaluated)
 *
 * @param {string} line  A single line of G-code or a `%` command.
 * @returns {string} The line with any `;` comment removed, trimmed.
 */
export function stripSemicolonComment(line) {
    return line.replace(SEMICOLON_COMMENT, '').trim();
}
