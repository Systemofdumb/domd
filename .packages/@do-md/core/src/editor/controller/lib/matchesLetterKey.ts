const LATIN_LETTER = /^[a-z]$/;

/** Whether this event presses `letter` — the letter on the key cap, on any
 *  keyboard layout.
 *
 *  `KeyboardEvent.code` cannot answer this. It names a position on a US
 *  QWERTY board, so `code === "KeyZ"` is the key labelled W on AZERTY and Y on
 *  QWERTZ. Binding undo that way did not merely fail to fire on ⌘Z: it fired
 *  on the AZERTY user's ⌘W and called preventDefault, so the host's Close
 *  Window accelerator never saw the keystroke and closing a window silently
 *  undid an edit instead.
 *
 *  `key` is the right signal for a letter. Shift changes only its case (hence
 *  the fold), never which letter it is — the Shift hazard that makes `code`
 *  correct for digits and punctuation ("9" → "(") simply does not exist here.
 *
 *  Fall back to position when `key` reports no Latin letter at all: a
 *  non-Latin layout (Arabic, Cyrillic, Greek) has nothing to match, and so
 *  does a macOS Option combination, where `key` is the composed glyph. Losing
 *  the binding outright would be worse than approximating it.
 */
export function matchesLetterKey(
    e: Pick<KeyboardEvent, "key" | "code">,
    letter: string,
) {
    const pressed = e.key.toLowerCase();
    if (LATIN_LETTER.test(pressed)) return pressed === letter;
    return e.code === `Key${letter.toUpperCase()}`;
}
