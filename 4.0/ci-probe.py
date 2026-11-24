"""The typo3-4-0 job's charset check: text saved into the seeded content element's
bodytext through the record editor, and read back from the editor, the database
and the frontend.

Used by .github/workflows/images.yml. Not used by the image.

    ci-probe.py frontend <html> <text>   check the frontend's <p class="bodytext">
    ci-probe.py frontend-blank <html>    check that paragraph shows nothing (the control)
    ci-probe.py form <html> <text>       check the record editor's bodytext field
    ci-probe.py form-blank <html>        check that field is blank (the control)
    ci-probe.py post <text>              print the bodytext as the editor's form posts it
    ci-probe.py stored-hex <text>        print the bytes 4.0 stores, as MySQL's HEX()

<text> is what a visitor should read, as UTF-8. Everything is compared as bytes,
because the pages are ISO-8859-1 and a text comparison would hide the encoding this
exists to check.

The bytes 4.0 stores are computed here, independently of TYPO3: an ISO-8859-1 form
submits what the charset can carry as single bytes and the rest as decimal numeric
character references, which is exactly Python's encode('latin-1',
'xmlcharrefreplace').
"""

import html
import os
import re
import sys
import urllib.parse

FIELD = b'data[tt_content][1][bodytext]'
# TCEforms writes the field as a <textarea>, its value through formatForTextarea():
# a newline, then htmlspecialchars() (t3lib/class.t3lib_div.php:1369).
TEXTAREA = rb'<textarea[^>]*name="' + re.escape(FIELD) + rb'"[^>]*>\n?(.*?)</textarea>'
# css_styled_content's text element: parseFunc_RTE wraps each line of the bodytext
# in a paragraph of class bodytext (static/setup.txt, lib.parseFunc_RTE).
PARAGRAPH = rb'<p class="bodytext">(.*?)</p>'


def stored_form(text):
    return text.encode('latin-1', 'xmlcharrefreplace')


def php_htmlspecialchars(raw):
    # PHP 5.6's default flags are ENT_COMPAT | ENT_HTML401: & " < > and not '.
    # Python's html.escape also escapes ', so it would not match what TCEforms sent.
    for plain, entity in ((b'&', b'&amp;'), (b'"', b'&quot;'), (b'<', b'&lt;'), (b'>', b'&gt;')):
        raw = raw.replace(plain, entity)
    return raw


def extract(page, pattern, what):
    match = re.search(pattern, page, re.S)
    if not match:
        sys.exit('::error::no ' + what + ' in the page')
    return match.group(1)


def main():
    mode = sys.argv[1]

    if mode in ('post', 'stored-hex'):
        stored = stored_form(os.fsencode(sys.argv[2]).decode('utf-8'))
        if mode == 'post':
            # Percent-encoded byte for byte, as a browser encodes an ISO-8859-1
            # form: the ø goes as %F8, the references as %26%23337%3B.
            print(urllib.parse.quote_from_bytes(FIELD, safe='') + '=' + urllib.parse.quote_from_bytes(stored, safe=''))
        else:
            print(stored.hex().upper())
        return

    page = open(sys.argv[2], 'rb').read()

    if mode == 'form-blank':
        value = extract(page, TEXTAREA, 'bodytext field')
        if value != b'':
            sys.exit('::error::the bodytext field was not blank: %r' % value)
        print('bodytext field blank, as the control predicts')
        return
    if mode == 'frontend-blank':
        # parseFunc_RTE's htmlspecialchars() leaves nothing, and encapsLines fills
        # an empty line with a non-breaking space (innerStdWrap_all.ifBlank).
        value = extract(page, PARAGRAPH, 'bodytext paragraph')
        if value not in (b'', b'&nbsp;'):
            sys.exit('::error::the bodytext paragraph was not blank: %r' % value)
        print('bodytext paragraph blank, as the control predicts')
        return

    text = os.fsencode(sys.argv[3]).decode('utf-8')
    stored = stored_form(text)

    if mode == 'frontend':
        found = extract(page, PARAGRAPH, 'bodytext paragraph')
        # parseFunc_RTE escapes the text and then restores entities
        # (htmlSpecialChars = 2, t3lib_parsehtml::bidir_htmlspecialchars()), so the
        # references reach the browser as references.
        if found != stored:
            sys.exit('::error::the bodytext rendered as %r, expected %r' % (found, stored))
        # What the visitor reads: the page is ISO-8859-1, and the browser decodes the
        # references. Checked so the claim is the assertion and not an inference
        # from it.
        seen = html.unescape(found.decode('latin-1'))
        if seen != text:
            sys.exit('::error::a browser would read %r, not %r' % (seen, text))
        print('frontend bodytext: %d bytes as stored, read as %s' % (len(found), seen))
    elif mode == 'form':
        found = extract(page, TEXTAREA, 'bodytext field')
        expected = php_htmlspecialchars(stored)
        if found != expected:
            sys.exit('::error::the bodytext field held %r, expected %r' % (found, expected))
        # The textarea decodes once, to the stored bytes, so the field shows the
        # references as typed text rather than as the characters they stand for.
        shown = html.unescape(found.decode('latin-1'))
        print('form bodytext: the field shows %s' % shown)
    else:
        sys.exit('unknown mode ' + mode)


main()
