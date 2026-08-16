"""aes_gcm.py - AES (FIPS-197) and AES-GCM (NIST SP 800-38D), pure Python,
standard library only.

Companion to emergency-decrypt.py. Lives next to it and is imported by it -
NOT a pip package, not fetched from the network, just a second local text
file. This is a straightforward implementation of two published, standard
algorithms (AES per FIPS-197, GCM mode per NIST SP 800-38D) exactly as
specified, not an invented scheme - the "no custom cryptography" rule (R20,
R32 of the project) is about not designing your own algorithm/protocol, not
about typing out a standard one by hand when no dependency is allowed to
provide it. See the module-level comment in emergency-decrypt.py for the
full reasoning and the decision record behind this file's existence.

Correctness is the only goal - NOT speed. This is a personal archive
decrypted by hand in an emergency, not a network service; a slow, obviously
correct implementation (Python-level loops, no lookup-table optimizations
for MixColumns, bit-by-bit GF(2^128) multiplication exactly as the spec
describes it) is the right trade-off here, not a fast one that is harder to
audit against the spec text.

Layout of this file:
  1. AES block cipher (FIPS-197) - S-box constructed algebraically (not
     copied from a printed table, to remove the risk of a transcription
     error in 256 hardcoded bytes), key schedule, forward cipher only
     (GCM never needs AES decryption - see the module docstring in the
     "GCM mode" section below for why).
  2. GCM mode (NIST SP 800-38D) - GF(2^128) multiplication, GHASH, GCTR,
     the J0/tag/ciphertext construction from section 7 of the spec.

Both layers are covered by real test vectors in aes_gcm_test.py - not
values computed by this same code (that would prove nothing) but official,
independently-sourced constants: FIPS-197 Appendix B/C.3 for the AES layer,
and NIST CAVP AES-128-GCM vectors for the GCM layer. See that file for the
exact sources and the reasoning about what is and isn't covered.
"""

from __future__ import annotations

import hmac


# ---------------------------------------------------------------------------
# 1. AES block cipher (FIPS-197)
# ---------------------------------------------------------------------------

# AES's finite field is GF(2^8) with reduction polynomial
# x^8 + x^4 + x^3 + x + 1, i.e. 0x11B (FIPS-197 section 4.2). `_xtime`
# multiplies by x (0x02) modulo that polynomial - the building block for the
# general multiplication routine below and for MixColumns' fixed
# coefficients (which are all small: 1, 2, 3).
def _xtime(a: int) -> int:
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _gf256_mul(a: int, b: int) -> int:
    """Multiply two bytes in GF(2^8) (FIPS-197 section 4.2), via the
    standard shift-and-add-if-bit-set method: process `b` bit by bit,
    adding (XOR-ing in) `a` whenever the current bit of `b` is set, and
    doubling `a` (via `_xtime`) between bits."""
    result = 0
    for _ in range(8):
        if b & 1:
            result ^= a
        a = _xtime(a)
        b >>= 1
    return result


def _gf256_inverse_table() -> bytes:
    """Multiplicative inverse of every nonzero byte in GF(2^8), by brute
    force (255*255 multiplications worst case - trivial for a one-time
    module-load cost, and it avoids trusting a hand-copied inverse table).
    `0` has no inverse; FIPS-197's S-box construction defines its "inverse"
    as 0 by convention (see `_affine_transform` below, applied to 0)."""
    inv = [0] * 256
    for a in range(1, 256):
        for b in range(1, 256):
            if _gf256_mul(a, b) == 1:
                inv[a] = b
                break
    return bytes(inv)


_GF256_INV = _gf256_inverse_table()


def _affine_transform(b: int) -> int:
    """The affine transformation FIPS-197 applies on top of the GF(2^8)
    inverse to build the S-box (section 5.1.1, equation for b'_i). Written
    out bit by bit exactly as the spec defines it - not the commonly seen
    "b ^ rotl(b,1) ^ rotl(b,2) ^ rotl(b,3) ^ rotl(b,4) ^ 0x63" shortcut,
    to keep this file checkable line-by-line against the spec text."""
    c = 0x63
    result = 0
    for i in range(8):
        bit = (
            ((b >> i) & 1)
            ^ ((b >> ((i + 4) % 8)) & 1)
            ^ ((b >> ((i + 5) % 8)) & 1)
            ^ ((b >> ((i + 6) % 8)) & 1)
            ^ ((b >> ((i + 7) % 8)) & 1)
            ^ ((c >> i) & 1)
        )
        result |= bit << i
    return result


# The S-box, computed once at import time from the algebraic definition
# above rather than hardcoded as a 256-entry table copied from a printed
# reference - eliminates the single biggest transcription-error risk in a
# from-scratch AES implementation. Verified against known S-box values by
# the test suite (S(0x00) = 0x63, S(0x01) = 0x7C, ...).
SBOX = bytes(_affine_transform(_GF256_INV[b]) for b in range(256))

# Round constants for the key schedule (FIPS-197 section 5.2): RCON[i] is
# the byte 2^(i-1) in GF(2^8), i.e. RCON[1] = 1 and RCON[i] = xtime(RCON[i-1])
# for i > 1. Computed the same way rather than hardcoded, for the same
# reason as the S-box above. Index 0 is unused (the schedule loop below
# starts at i=1); 15 entries covers the largest key size (AES-256, Nk=8,
# Nr=14 needs up to round word index 4*(Nr+1)-1 = 59, i.e. Rcon[i/Nk] up to
# i/Nk = 14 - see `_key_expansion`).
def _rcon_table() -> list[int]:
    table = [0] * 15
    table[1] = 1
    for i in range(2, 15):
        table[i] = _xtime(table[i - 1])
    return table


_RCON = _rcon_table()


def _sub_word(word: bytes) -> bytes:
    return bytes(SBOX[b] for b in word)


def _rot_word(word: bytes) -> bytes:
    return word[1:] + word[:1]


def _key_expansion(key: bytes) -> list[bytes]:
    """FIPS-197 section 5.2. `key` is 16, 24 or 32 bytes (AES-128/192/256).
    Returns Nb*(Nr+1) 4-byte words (Nb = 4 always for AES)."""
    nk = len(key) // 4
    if nk not in (4, 6, 8):
        raise ValueError(f"AES key must be 16, 24 or 32 bytes, got {len(key)}")
    nr = nk + 6
    nb = 4

    w: list[bytes] = [key[4 * i : 4 * i + 4] for i in range(nk)]
    for i in range(nk, nb * (nr + 1)):
        temp = w[i - 1]
        if i % nk == 0:
            temp = _sub_word(_rot_word(temp))
            temp = bytes([temp[0] ^ _RCON[i // nk], temp[1], temp[2], temp[3]])
        elif nk > 6 and i % nk == 4:
            temp = _sub_word(temp)
        w.append(bytes(a ^ b for a, b in zip(w[i - nk], temp)))
    return w


def _sub_bytes(state: bytearray) -> None:
    for i in range(16):
        state[i] = SBOX[state[i]]


def _shift_rows(state: bytearray) -> bytearray:
    # `state[r + 4*c]` holds row r, column c (FIPS-197's column-major byte
    # numbering - see the module note in `AES.encrypt_block` below for why
    # no rearrangement is needed when loading the input block). Row r is
    # cyclically shifted left by r positions.
    new_state = bytearray(16)
    for r in range(4):
        for c in range(4):
            new_state[r + 4 * c] = state[r + 4 * ((c + r) % 4)]
    return new_state


def _mix_single_column(a0: int, a1: int, a2: int, a3: int) -> tuple[int, int, int, int]:
    # FIPS-197 section 5.1.3 - fixed matrix multiplication in GF(2^8).
    mul = _gf256_mul
    b0 = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3
    b1 = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3
    b2 = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3)
    b3 = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2)
    return b0, b1, b2, b3


def _mix_columns(state: bytearray) -> None:
    for c in range(4):
        a0, a1, a2, a3 = state[4 * c], state[4 * c + 1], state[4 * c + 2], state[4 * c + 3]
        b0, b1, b2, b3 = _mix_single_column(a0, a1, a2, a3)
        state[4 * c], state[4 * c + 1], state[4 * c + 2], state[4 * c + 3] = b0, b1, b2, b3


def _add_round_key(state: bytearray, round_words: list[bytes]) -> None:
    round_key = b"".join(round_words)
    for i in range(16):
        state[i] ^= round_key[i]


class AES:
    """AES forward cipher only (FIPS-197) - GCM mode never needs AES
    decryption (see the "GCM mode" section below: both encryption and
    decryption of the vault body only ever call `encrypt_block`, because
    GCM is built on counter mode, and counter mode only ever runs the
    block cipher forwards, XOR-ing its output with data - see NIST SP
    800-38D section 6.5, "GCTR")."""

    def __init__(self, key: bytes):
        self.nk = len(key) // 4
        if self.nk not in (4, 6, 8):
            raise ValueError(f"AES key must be 16, 24 or 32 bytes, got {len(key)}")
        self.nr = self.nk + 6
        self.round_keys = _key_expansion(key)

    def encrypt_block(self, block: bytes) -> bytes:
        if len(block) != 16:
            raise ValueError(f"AES block must be exactly 16 bytes, got {len(block)}")
        nb = 4
        # `state[r + 4c] = block[r + 4c]` directly, with no rearrangement:
        # FIPS-197 defines the input byte numbering as "byte n is in row
        # (n mod 4), column floor(n/4)" - exactly n = r + 4c - so a plain
        # byte-for-byte copy of the input already IS the column-major state
        # this implementation uses throughout.
        state = bytearray(block)

        _add_round_key(state, self.round_keys[0:nb])
        for rnd in range(1, self.nr):
            _sub_bytes(state)
            state = _shift_rows(state)
            _mix_columns(state)
            _add_round_key(state, self.round_keys[rnd * nb : (rnd + 1) * nb])
        _sub_bytes(state)
        state = _shift_rows(state)
        _add_round_key(state, self.round_keys[self.nr * nb : (self.nr + 1) * nb])

        return bytes(state)


# ---------------------------------------------------------------------------
# 2. GCM mode (NIST SP 800-38D)
# ---------------------------------------------------------------------------

# The GCM reduction constant R = 11100001 || 0^120 (section 6.3) - the
# top byte is 0xE1, the rest is zero, represented as a 128-bit integer
# with the block's leftmost (most significant, per the spec's bit
# numbering) bit as the integer's most significant bit.
_GCM_R = 0xE1 << 120


def _gf128_mul(x: int, y: int) -> int:
    """Multiplication in GF(2^128) (NIST SP 800-38D section 6.3, Algorithm
    1), operating bit by bit exactly as the spec's algorithm describes it -
    `x` and `y` are 128-bit blocks represented as Python ints, with the
    block's leftmost bit (spec's "bit 0", most significant in the block) as
    the integer's most significant bit - i.e. `int.from_bytes(block,
    "big")`. This is the slow, obviously-correct version (no precomputed
    tables) - see the module docstring: correctness over speed."""
    z = 0
    v = y
    for i in range(128):
        if (x >> (127 - i)) & 1:
            z ^= v
        if v & 1:  # LSB of V_i, i.e. the block's rightmost bit
            v = (v >> 1) ^ _GCM_R
        else:
            v = v >> 1
    return z


def _ghash(h: int, data: bytes) -> int:
    """GHASH (NIST SP 800-38D section 6.4). `data` must already be a
    multiple of 16 bytes - callers are responsible for the zero-padding the
    spec's GHASH input construction requires (see `_gcm_core` below), this
    function only does the block-by-block accumulation."""
    if len(data) % 16 != 0:
        raise ValueError("ghash() input must be a multiple of 16 bytes")
    y = 0
    for i in range(0, len(data), 16):
        block = int.from_bytes(data[i : i + 16], "big")
        y = _gf128_mul(y ^ block, h)
    return y


def _inc32(block_int: int) -> int:
    """`inc32` (NIST SP 800-38D section 6.2): increment only the rightmost
    32 bits of a 128-bit block, modulo 2^32, leaving the leftmost 96 bits
    untouched."""
    low32 = (block_int & 0xFFFFFFFF) + 1 & 0xFFFFFFFF
    high96 = block_int & ~0xFFFFFFFF
    return high96 | low32


def _gctr(aes: AES, icb: bytes, data: bytes) -> bytes:
    """GCTR (NIST SP 800-38D section 6.5): counter-mode encryption, used
    for both the ciphertext (with ICB = inc32(J0)) and, with a single
    16-byte input, for the authentication tag (with ICB = J0 itself, see
    `gcm_encrypt`/`gcm_decrypt`). Empty input gives empty output (spec: "if
    X is the empty string, then... output the empty string" - a real
    branch, not a shortcut, needed for empty-plaintext vaults like a
    freshly created, still-empty base)."""
    if len(data) == 0:
        return b""
    counter = int.from_bytes(icb, "big")
    out = bytearray()
    for start in range(0, len(data), 16):
        keystream = aes.encrypt_block(counter.to_bytes(16, "big"))
        chunk = data[start : start + 16]
        out.extend(a ^ b for a, b in zip(chunk, keystream))
        counter = _inc32(counter)
    return bytes(out)


def _pad16(data: bytes) -> bytes:
    remainder = len(data) % 16
    return data if remainder == 0 else data + b"\x00" * (16 - remainder)


def _compute_j0(h_int: int, iv: bytes) -> bytes:
    """NIST SP 800-38D section 7.1, step 2. This project's own vault format
    always uses a 12-byte (96-bit) IV (FORMAT.md - `crypto.ts` never
    generates any other length), which takes the simple branch of the spec
    (`J0 = IV || 0^31 || 1`). The general branch (GHASH of the IV, for any
    other IV length) is implemented too, faithfully, rather than assumed
    away - it is exercised by the general NIST GCM test vectors regardless
    of what this project's own format happens to use, and a from-scratch
    implementation that silently only worked for one IV length would not
    really be "by the spec"."""
    if len(iv) == 12:
        return iv + b"\x00\x00\x00\x01"
    s = 16 - (len(iv) % 16) if len(iv) % 16 != 0 else 0
    padded = iv + b"\x00" * s + b"\x00" * 8 + (len(iv) * 8).to_bytes(8, "big")
    return _ghash(h_int, padded).to_bytes(16, "big")


class InvalidTagError(Exception):
    """GCM authentication tag did not match - wrong key or corrupted data.
    Mirrors `DecryptError` in crypto.ts / `VaultDecryptError` in
    emergency-decrypt.py: GCM cannot and does not try to distinguish the
    two causes (NIST SP 800-38D section 7.2, step 6: "FAIL")."""


def _derive_h_and_j0(aes: AES, iv: bytes) -> tuple[int, bytes]:
    """NIST SP 800-38D section 7, steps 1-2, shared verbatim between
    `gcm_encrypt` and `gcm_decrypt`: H = CIPH_K(0^128), then J0 from the
    IV. Returns `(h_int, j0_bytes)` - `h_int` because `_ghash` and
    `_gf128_mul` work on ints, `j0_bytes` because it is used directly as
    an ICB for `_gctr` (which takes bytes) by both callers."""
    h_int = int.from_bytes(aes.encrypt_block(b"\x00" * 16), "big")
    j0 = _compute_j0(h_int, iv)
    return h_int, j0


def _compute_s(h_int: int, aad: bytes, ciphertext: bytes) -> int:
    """NIST SP 800-38D section 7, steps 4-5, shared verbatim between
    `gcm_encrypt` and `gcm_decrypt`: GHASH over AAD and ciphertext, each
    zero-padded to a multiple of 16 bytes, followed by their bit-lengths as
    two 64-bit big-endian integers. `gcm_encrypt` can only call this AFTER
    it has produced `ciphertext` (via `_gctr` with `inc32(J0)`, using the
    same H/J0 from `_derive_h_and_j0` - the two functions can't share one
    single "compute H, J0 and S" helper because encrypt's ciphertext,
    which S depends on, does not exist yet at the point J0 is derived).
    `gcm_decrypt` already has `ciphertext` as an input, so it calls this
    immediately after `_derive_h_and_j0`."""
    s_input = (
        _pad16(aad)
        + _pad16(ciphertext)
        + (len(aad) * 8).to_bytes(8, "big")
        + (len(ciphertext) * 8).to_bytes(8, "big")
    )
    return _ghash(h_int, s_input)


def gcm_encrypt(key: bytes, iv: bytes, plaintext: bytes, aad: bytes = b"") -> tuple[bytes, bytes]:
    """AES-GCM encryption (NIST SP 800-38D section 7.1). Returns
    (ciphertext, tag), both without any implicit combination - this
    project's container format (FORMAT.md) appends the tag to the
    ciphertext itself when it stores `ct`, matching what `crypto.subtle`
    does in `crypto.ts`; combining them is the caller's job
    (`gcm_decrypt` below expects the same split form back)."""
    aes = AES(key)
    h_int, j0 = _derive_h_and_j0(aes, iv)
    j0_int = int.from_bytes(j0, "big")

    ciphertext = _gctr(aes, _inc32(j0_int).to_bytes(16, "big"), plaintext)

    s = _compute_s(h_int, aad, ciphertext)
    tag = _gctr(aes, j0, s.to_bytes(16, "big"))

    return ciphertext, tag


def gcm_decrypt(key: bytes, iv: bytes, ciphertext: bytes, tag: bytes, aad: bytes = b"") -> bytes:
    """AES-GCM decryption (NIST SP 800-38D section 7.2). Verifies the tag
    BEFORE returning any plaintext (constant-time comparison via
    `hmac.compare_digest`, stdlib) - raises `InvalidTagError` instead of
    ever handing back plaintext that failed authentication, matching the
    "GCM decrypt either fully succeeds or fully fails" guarantee the rest
    of this project relies on (FORMAT.md section 4)."""
    aes = AES(key)
    h_int, j0 = _derive_h_and_j0(aes, iv)
    j0_int = int.from_bytes(j0, "big")

    s = _compute_s(h_int, aad, ciphertext)
    expected_tag = _gctr(aes, j0, s.to_bytes(16, "big"))[: len(tag)]

    if not hmac.compare_digest(expected_tag, tag):
        raise InvalidTagError("GCM authentication tag mismatch: wrong key or corrupted data")

    return _gctr(aes, _inc32(j0_int).to_bytes(16, "big"), ciphertext)
