"""Encrypts a password the way 6.2's backend login form does, for rsaauth.

Used by 6.2/ci-login.sh. Not used by the image.

    ci-rsa.py <modulus hex> <exponent hex> <password>   prints rsa:<base64>

A fresh 6.2 sets [BE][loginSecurityLevel] = 'rsa' (FactoryConfiguration.php), so
the login form never sends the password, nor 4.5's md5 challenge. Its JavaScript
asks ajax.php for a public key, encrypts the password with jsbn's RSAKey.encrypt(),
and posts "rsa:" plus the base64 of the result
(typo3/sysext/rsaauth/resources/BackendLoginFormRsaEncryption.js). rsaauth then
decrypts it with openssl_private_decrypt() and PHP's default padding
(Classes/Backend/PhpBackend.php, decrypt()).

jsbn's encrypt() pads with PKCS#1 v1.5, block type 2 (rsa.js, pkcs1pad2()), and
that is OpenSSL's default too, so this does the same in a few lines of integer
arithmetic rather than adding a crypto library to the runner. The ciphertext is
written out to the full length of the modulus; openssl_private_decrypt() wants
exactly that many bytes.
"""

import base64
import os
import sys


def pkcs1_v15_type2(message, length):
    padding_length = length - 3 - len(message)
    if padding_length < 8:
        sys.exit('::error::the password is too long for this key')
    padding = b''
    while len(padding) < padding_length:
        padding += bytes(b for b in os.urandom(padding_length) if b != 0)
    return b'\x00\x02' + padding[:padding_length] + b'\x00' + message


def main():
    modulus = int(sys.argv[1], 16)
    exponent = int(sys.argv[2], 16)
    password = os.fsencode(sys.argv[3])

    length = (modulus.bit_length() + 7) // 8
    block = int.from_bytes(pkcs1_v15_type2(password, length), 'big')
    cipher = pow(block, exponent, modulus).to_bytes(length, 'big')
    print('rsa:' + base64.b64encode(cipher).decode('ascii'))


main()
