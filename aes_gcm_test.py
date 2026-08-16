"""aes_gcm_test.py - tests for aes_gcm.py against official, independently
sourced test vectors. NOT against values this same code computes (an
assertion that checks a result the same way the code under test computes it
can never disagree with that code - see the test contract in ticket 05's
report) - every expected value here comes from a published standard or an
independent reference implementation's test suite.

Run: `python aes_gcm_test.py` (stdlib `unittest`, no pip install, same rule
as emergency-decrypt.py itself).

Sources, and how each was checked before being trusted enough to hardcode:

  - FIPS-197 (AES) test vectors: Appendix B's worked cipher example
    (AES-128) and Appendix C.3 (AES-256). Both were cross-checked against
    an independent extraction from Go's standard library test suite
    (`src/crypto/aes/aes_test.go`) and matched exactly, character for
    character - not taken from a single source on faith.

  - NIST CAVP AES-128-GCM test vectors (empty plaintext, 96-bit IV,
    varying AAD length): pulled from a mirrored copy of NIST's official
    `gcmEncryptExtIV128.rsp` CAVP file. The first of these four (Key =
    11754cd72aec309bf52f7687212e8957) was independently cross-checked
    against Go's `crypto/cipher` test suite (`gcm_test.go`) - two
    unrelated source files agreeing byte-for-byte on key/IV/tag is strong
    evidence against a transcription or retrieval error, which is why this
    specific vector was trusted enough to also cross-validate the other
    three from the same CAVP mirror.

  - What these vectors do NOT cover: non-empty plaintext. All four CAVP
    vectors above use empty plaintext/ciphertext - reliably retrieving an
    official NIST vector with real multi-block plaintext from the sources
    available while writing this file kept producing corrupted results
    (one supposed AES-256 vector came back as a well-known 128-bit test
    key literally duplicated to reach 256 bits - a clear retrieval
    artifact, discarded rather than used). That gap - real, multi-block
    ciphertext, specifically AES-256 combined with GCM (this project's
    actual algorithm) - is NOT closed by `GcmSelfConsistencyTest` below
    (an internal encrypt-then-decrypt roundtrip only proves internal
    consistency, not correctness against an independent source). It is
    closed by `vaultStore.crossCompat.test.js` in the main project
    instead: a real multi-block AES-256-GCM ciphertext produced by the
    browser's WebCrypto (`crypto.subtle`, an independent, audited
    implementation - not this file's own code) is decrypted by
    `emergency-decrypt.py` (which calls into this module) and compared
    byte-for-byte to the original JSON. That test doesn't live in this
    file because it needs the Node/Vitest side to produce the reference
    ciphertext.
"""

from __future__ import annotations

import unittest

from aes_gcm import AES, SBOX, gcm_decrypt, gcm_encrypt, InvalidTagError, _gf128_mul


class AesBlockCipherTest(unittest.TestCase):
    """AES forward cipher, independent of GCM - FIPS-197."""

    def test_sbox_known_values(self):
        # Hand-derived from FIPS-197's affine transformation (see the
        # derivation in ticket 05's report) before ever running the code -
        # an expected value computed independently of `_affine_transform`,
        # not by it.
        self.assertEqual(SBOX[0x00], 0x63)
        self.assertEqual(SBOX[0x01], 0x7C)

    def test_aes_128_fips197_appendix_b(self):
        key = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
        plaintext = bytes.fromhex("3243f6a8885a308d313198a2e0370734")
        expected_ciphertext = bytes.fromhex("3925841d02dc09fbdc118597196a0b32")

        self.assertEqual(AES(key).encrypt_block(plaintext), expected_ciphertext)

    def test_aes_256_fips197_appendix_c3(self):
        key = bytes.fromhex(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        )
        plaintext = bytes.fromhex("00112233445566778899aabbccddeeff")
        expected_ciphertext = bytes.fromhex("8ea2b7ca516745bfeafc49904b496089")

        self.assertEqual(AES(key).encrypt_block(plaintext), expected_ciphertext)

    def test_rejects_wrong_key_length(self):
        with self.assertRaises(ValueError):
            AES(b"too short")

    def test_rejects_wrong_block_length(self):
        with self.assertRaises(ValueError):
            AES(b"0" * 16).encrypt_block(b"not sixteen bytes")


class Gf128MulTest(unittest.TestCase):
    """GF(2^128) multiplication (NIST SP 800-38D section 6.3) - the
    building block under GHASH. Checked against a mathematical property of
    the field itself (multiplying by the identity element, the all-zero
    block's successor under this operation is not it - GF(2^128) has no
    "1" represented as a plain integer 1 the way normal multiplication
    does, so instead this checks the defined edge case from the spec:
    multiplying anything by the zero block gives the zero block), which is
    a property of the algorithm's definition, not a value computed by the
    same code path being tested.
    """

    def test_multiplying_by_zero_gives_zero(self):
        x = int.from_bytes(bytes.fromhex("66e94bd4ef8a2c3b884cfa59ca342b2e"), "big")
        self.assertEqual(_gf128_mul(x, 0), 0)
        self.assertEqual(_gf128_mul(0, x), 0)


class GcmNistVectorsTest(unittest.TestCase):
    """NIST CAVP AES-128-GCM test vectors (96-bit IV, empty plaintext,
    varying AAD length) - see the module docstring above for sources and
    cross-validation. Expected tags are official published constants, not
    values this code computed."""

    def _check(self, key_hex, iv_hex, aad_hex, expected_tag_hex):
        key = bytes.fromhex(key_hex)
        iv = bytes.fromhex(iv_hex)
        aad = bytes.fromhex(aad_hex)
        expected_tag = bytes.fromhex(expected_tag_hex)

        ciphertext, tag = gcm_encrypt(key, iv, b"", aad)
        self.assertEqual(ciphertext, b"")
        self.assertEqual(tag, expected_tag)

        # And the decrypt direction: verifying the official tag must
        # succeed and return empty plaintext, not raise.
        plaintext = gcm_decrypt(key, iv, ciphertext, expected_tag, aad)
        self.assertEqual(plaintext, b"")

    def test_vector_1_no_aad(self):
        # Cross-validated independently against Go's crypto/cipher test
        # suite (gcm_test.go) - same key/IV/tag from an unrelated source.
        self._check(
            "11754cd72aec309bf52f7687212e8957",
            "3c819d9a9bed087615030b65",
            "",
            "250327c674aaf477aef2675748cf6971",
        )

    def test_vector_2_128_bit_aad(self):
        self._check(
            "77be63708971c4e240d1cb79e8d77feb",
            "e0e00f19fed7ba0136a797f3",
            "7a43ec1d9c0a5a78a0b16533a6213cab",
            "209fcc8d3675ed938e9c7166709dd946",
        )

    def test_vector_3_160_bit_aad(self):
        self._check(
            "2fb45e5b8f993a2bfebc4b15b533e0b4",
            "5b05755f984d2b90f94b8027",
            "e85491b2202caf1d7dce03b97e09331c32473941",
            "c75b7832b2a2d9bd827412b6ef5769db",
        )

    def test_vector_4_384_bit_aad(self):
        self._check(
            "99e3e8793e686e571d8285c564f75e2b",
            "c2dd0ab868da6aa8ad9c0d23",
            "b668e42d4e444ca8b23cfdd95a9fedd5178aa521144890b093733cf5cf2252"
            "6c5917ee476541809ac6867a8c399309fc",
            "3f4fba100eaf1f34b0baadaae9995d85",
        )

    def test_wrong_tag_is_rejected(self):
        key = bytes.fromhex("11754cd72aec309bf52f7687212e8957")
        iv = bytes.fromhex("3c819d9a9bed087615030b65")
        wrong_tag = bytes.fromhex("00000000000000000000000000000000")[:16]

        with self.assertRaises(InvalidTagError):
            gcm_decrypt(key, iv, b"", wrong_tag, b"")


class GcmSelfConsistencyTest(unittest.TestCase):
    """Roundtrip checks for what the four empty-plaintext NIST vectors
    above cannot exercise: real, non-empty, multi-block plaintext, and the
    inc32() counter-increment path inside GCTR. This only proves internal
    consistency (encrypt then decrypt gets the original back) - it does
    NOT independently prove correctness against a trusted external source
    the way the NIST vectors above do. That independent proof for
    multi-block AES-256-GCM specifically is `vaultStore.crossCompat.test.js`
    (decrypts a real ciphertext produced by the browser's WebCrypto) - see
    the module docstring."""

    def test_roundtrip_multi_block_plaintext_aes_256(self):
        key = bytes(range(32))  # 32 arbitrary distinct bytes - AES-256
        iv = bytes.fromhex("000000000000000000000001")
        plaintext = b"The quick brown fox jumps over the lazy dog. " * 5  # > 3 blocks
        aad = b"vault-header-metadata"

        ciphertext, tag = gcm_encrypt(key, iv, plaintext, aad)
        self.assertNotEqual(ciphertext, plaintext)
        self.assertEqual(len(ciphertext), len(plaintext))

        recovered = gcm_decrypt(key, iv, ciphertext, tag, aad)
        self.assertEqual(recovered, plaintext)

    def test_roundtrip_detects_tampered_ciphertext(self):
        key = bytes(range(32))
        iv = bytes.fromhex("000000000000000000000002")
        plaintext = b"sixteen-byte-pt!"

        ciphertext, tag = gcm_encrypt(key, iv, plaintext)
        tampered = bytes([ciphertext[0] ^ 0x01]) + ciphertext[1:]

        with self.assertRaises(InvalidTagError):
            gcm_decrypt(key, iv, tampered, tag)


if __name__ == "__main__":
    unittest.main()
