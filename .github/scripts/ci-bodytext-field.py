"""Check that the record editor shows <text> in the seeded content element's bodytext.

Used by the typo3-4-5 and typo3-6-2 jobs in .github/workflows/images.yml, whose
backends are UTF-8. 4.0's ISO-8859-1 editor has its own check, 4.0/ci-probe.py.

    ci-bodytext-field.py <html> <text>

TCEforms writes the field as a <textarea>, its value through formatForTextarea(): a
newline, then htmlspecialchars(). 6.2 loads rtehtmlarea, whose hidden <textarea>
carries the same field, transformed for the editor: each line of plain text in a
<p>. Either way the field must hold the text itself, byte for byte.
"""

import html
import os
import re
import sys

page = open(sys.argv[1], 'rb').read().decode('utf-8')
text = os.fsencode(sys.argv[2]).decode('utf-8')

match = re.search(r'<textarea[^>]*name="data\[tt_content\]\[1\]\[bodytext\]"[^>]*>\n?(.*?)</textarea>', page, re.S)
if not match:
    sys.exit('::error::no bodytext field in the page')
value = html.unescape(match.group(1))
shown = re.sub(r'^<p>(.*)</p>$', r'\1', value, flags=re.S)
if shown != text:
    sys.exit('::error::the bodytext field held %r, expected %r' % (value, text))
print('bodytext field: %s' % shown)
