import { afterEach, describe, expect, test, vi } from 'vitest';
import { CODE_LENGTH, MAX_NAME_LENGTH } from '@aoe/protocol';
import {
  canSubmitInviteJoin,
  copyInviteUrl,
  createInviteEntryState,
  inviteErrorMessage,
  inviteUrl,
  isLocalhostOrigin,
  parseInviteRoom,
  sanitizeInviteInput,
  sanitizePlayerName,
  setInviteCode,
  setInviteError,
  setInviteJoining,
  setInviteName,
  shareableInviteUrl,
  validateInviteJoin,
} from './invite-link';

describe('M06 invite-link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('I01: Invite URL construction, localhost detection, and secret exclusion', () => {
    test('builds normalized ?room=CODE URL for LAN IP and HTTPS public origins', () => {
      expect(inviteUrl('http://192.168.1.25:8787', 'ab-c d2')).toBe('http://192.168.1.25:8787/?room=ABCD2');
      expect(inviteUrl('https://match.trycloudflare.com', 'efgh3')).toBe('https://match.trycloudflare.com/?room=EFGH3');
    });

    test('never serializes token, botToken, paths, or fragments from origin input', () => {
      const built = inviteUrl(
        'https://play.example.com:8443/lobby?token=rejoin-secret&botToken=bot-secret#frag',
        'abcd2',
      );
      expect(built).toBe('https://play.example.com:8443/?room=ABCD2');
      expect(built).not.toContain('token');
      expect(built).not.toContain('botToken');
      expect(built).not.toContain('secret');
      expect(built).not.toContain('#frag');
    });

    test('rejects invalid origins and invalid room codes in inviteUrl', () => {
      expect(() => inviteUrl('', 'ABCD2')).toThrow();
      expect(() => inviteUrl('not-a-url', 'ABCD2')).toThrow();
      expect(() => inviteUrl('ws://192.168.1.25:8787', 'ABCD2')).toThrow();
      expect(() => inviteUrl('javascript:alert(1)', 'ABCD2')).toThrow();
      expect(() => inviteUrl('https://user:pass@example.com', 'ABCD2')).toThrow();
      expect(() => inviteUrl('http://192.168.1.25:8787', 'ABC')).toThrow();
      expect(() => inviteUrl('http://192.168.1.25:8787', 'ABC01')).toThrow();
    });

    test('isLocalhostOrigin detects loopback/localhost variants and allows LAN/public origins', () => {
      expect(isLocalhostOrigin('http://localhost:8787')).toBe(true);
      expect(isLocalhostOrigin('https://sub.localhost:5173')).toBe(true);
      expect(isLocalhostOrigin('http://localhost.:8787')).toBe(true);
      expect(isLocalhostOrigin('http://127.0.0.1:8787')).toBe(true);
      expect(isLocalhostOrigin('http://127.0.1.1:8787')).toBe(true);
      expect(isLocalhostOrigin('http://0.0.0.0:8787')).toBe(true);
      expect(isLocalhostOrigin('http://[::1]:8787')).toBe(true);
      expect(isLocalhostOrigin('http://[0:0:0:0:0:0:0:1]:8787')).toBe(true);
      expect(isLocalhostOrigin('http://[::]:8787')).toBe(true);
      expect(isLocalhostOrigin('http://[::ffff:127.0.0.1]:8787')).toBe(true);

      expect(isLocalhostOrigin('http://192.168.1.10:8787')).toBe(false);
      expect(isLocalhostOrigin('http://10.0.0.5:8787')).toBe(false);
      expect(isLocalhostOrigin('http://172.16.0.4:8787')).toBe(false);
      expect(isLocalhostOrigin('https://room-host.trycloudflare.com')).toBe(false);
      expect(isLocalhostOrigin('not-a-url')).toBe(false);
    });

    test('shareableInviteUrl blocks localhost and invalid inputs while allowing LAN and public HTTPS', () => {
      expect(shareableInviteUrl('http://localhost:8787', 'ABCD2')).toEqual({ ok: false, reason: 'localhost' });
      expect(shareableInviteUrl('http://127.0.0.1:8787', 'ABCD2')).toEqual({ ok: false, reason: 'localhost' });
      expect(shareableInviteUrl('http://[::1]:8787', 'ABCD2')).toEqual({ ok: false, reason: 'localhost' });
      expect(shareableInviteUrl('http://0.0.0.0:8787', 'ABCD2')).toEqual({ ok: false, reason: 'localhost' });
      expect(shareableInviteUrl('ws://192.168.1.10:8787', 'ABCD2')).toEqual({ ok: false, reason: 'invalid-origin' });
      expect(shareableInviteUrl('http://192.168.1.10:8787', 'BAD01')).toEqual({ ok: false, reason: 'invalid-code' });

      expect(shareableInviteUrl('http://192.168.1.10:8787', 'ab-cd2')).toEqual({
        ok: true,
        url: 'http://192.168.1.10:8787/?room=ABCD2',
      });
      expect(shareableInviteUrl('https://tunnel.example.com', 'efgh3')).toEqual({
        ok: true,
        url: 'https://tunnel.example.com/?room=EFGH3',
      });
    });
  });

  describe('I02: Opening an invite link requires valid name and never auto-readies or auto-starts', () => {
    test('createInviteEntryState prefills code from invite URL without autoReady/autoStart', () => {
      const state = createInviteEntryState('http://192.168.1.10:8787/?room=ab-cd2');
      expect(state).toEqual({
        code: 'ABCD2',
        name: '',
        error: null,
        joining: false,
        fromInvite: true,
        autoReady: false,
        autoStart: false,
      });
      expect(canSubmitInviteJoin(state)).toBe(false);
      expect(validateInviteJoin(state)).toEqual({
        ok: false,
        reason: 'empty-name',
        message: 'Please enter your player name before joining.',
      });
    });

    test('requires non-empty player name (1..MAX_NAME_LENGTH) before join can submit', () => {
      let state = createInviteEntryState('https://tunnel.example.com/?room=WXYZ9');
      state = setInviteName(state, '   ');
      expect(canSubmitInviteJoin(state)).toBe(false);

      state = setInviteName(state, 'Alice');
      expect(canSubmitInviteJoin(state)).toBe(true);
      expect(validateInviteJoin(state)).toEqual({
        ok: true,
        code: 'WXYZ9',
        name: 'Alice',
      });
      expect(state.autoReady).toBe(false);
      expect(state.autoStart).toBe(false);
    });

    test('prevents duplicate submit while joining is in progress', () => {
      let state = createInviteEntryState('https://tunnel.example.com/?room=WXYZ9', 'Alice');
      expect(canSubmitInviteJoin(state)).toBe(true);

      state = setInviteJoining(state, true);
      expect(canSubmitInviteJoin(state)).toBe(false);
      expect(validateInviteJoin(state).ok).toBe(false);
    });
  });

  describe('I03: Error handling and retry preserves form inputs', () => {
    test('invalid URL room code leaves code empty and does not trigger join', () => {
      const state = createInviteEntryState('https://tunnel.example.com/?room=INVALID0');
      expect(state.code).toBe('');
      expect(state.fromInvite).toBe(false);
      expect(canSubmitInviteJoin(state)).toBe(false);
    });

    test('setInviteError records clear message while preserving code and name for retry', () => {
      let state = createInviteEntryState('http://192.168.1.10:8787/?room=ABCD2', 'Minh');
      state = setInviteJoining(state, true);
      state = setInviteError(state, inviteErrorMessage('room-full'));

      expect(state.error).toBe('That game is full.');
      expect(state.joining).toBe(false);
      expect(state.code).toBe('ABCD2');
      expect(state.name).toBe('Minh');
      expect(state.fromInvite).toBe(true);

      // User can adjust room code and retry without retyping name
      state = setInviteCode(state, 'efgh3');
      expect(state.error).toBeNull();
      expect(state.code).toBe('EFGH3');
      expect(state.name).toBe('Minh');
      expect(canSubmitInviteJoin(state)).toBe(true);
    });

    test('maps standard server and validation error codes to clear messages', () => {
      expect(inviteErrorMessage('bad-code')).toBe('No game with that invite code.');
      expect(inviteErrorMessage('room-full')).toBe('That game is full.');
      expect(inviteErrorMessage('room-started')).toBe('That game has already started.');
      expect(inviteErrorMessage('version-mismatch')).toBe('Your game version does not match the room.');
      expect(inviteErrorMessage('connection')).toBe('Cannot reach the game server.');
      expect(inviteErrorMessage('unknown-code', 'Custom <b>fallback</b>')).toBe('Custom bfallback/b');
    });
  });

  describe('I04: Clipboard copy with manual focus/select fallback', () => {
    test('uses navigator.clipboard.writeText when available and resolves clipboard method', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const fallback = { focus: vi.fn(), select: vi.fn() };

      const result = await copyInviteUrl('http://192.168.1.10:8787/?room=ABCD2', fallback);
      expect(result).toEqual({ copied: true, method: 'clipboard' });
      expect(writeText).toHaveBeenCalledWith('http://192.168.1.10:8787/?room=ABCD2');
      expect(fallback.focus).not.toHaveBeenCalled();
      expect(fallback.select).not.toHaveBeenCalled();
    });

    test('falls back to manual focus and select when clipboard rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const fallback = { focus: vi.fn(), select: vi.fn() };

      const result = await copyInviteUrl('http://192.168.1.10:8787/?room=ABCD2', fallback);
      expect(result).toEqual({ copied: false, method: 'manual' });
      expect(fallback.focus).toHaveBeenCalledTimes(1);
      expect(fallback.select).toHaveBeenCalledTimes(1);
    });

    test('falls back to manual focus and select when clipboard API is unavailable', async () => {
      vi.stubGlobal('navigator', {});
      const fallback = { focus: vi.fn(), select: vi.fn() };

      const result = await copyInviteUrl('http://192.168.1.10:8787/?room=ABCD2', fallback);
      expect(result).toEqual({ copied: false, method: 'manual' });
      expect(fallback.focus).toHaveBeenCalledTimes(1);
      expect(fallback.select).toHaveBeenCalledTimes(1);
    });

    test('handles missing fallback input without throwing when clipboard fails', async () => {
      vi.stubGlobal('navigator', {});
      const result = await copyInviteUrl('http://192.168.1.10:8787/?room=ABCD2');
      expect(result).toEqual({ copied: false, method: 'manual' });
    });
  });

  describe('I05: Malformed URLs, duplicate query params, XSS and shell injection safety', () => {
    test('parseInviteRoom accepts valid absolute/relative URLs and ignores unrelated params', () => {
      expect(parseInviteRoom('http://192.168.1.10:8787/?room=abcd2')).toBe('ABCD2');
      expect(parseInviteRoom('?room=ab-c%20d2')).toBe('ABCD2');
      expect(parseInviteRoom('/?foo=1&room=EFGH3&token=ignore-me')).toBe('EFGH3');
    });

    test('parseInviteRoom rejects duplicate ?room= query params deterministically', () => {
      expect(parseInviteRoom('https://example.com/?room=ABCD2&room=EFGH3')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=ABCD2&room=ABCD2')).toBeNull();
      expect(parseInviteRoom('?room=ABCD2&room=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).toBeNull();
    });

    test('parseInviteRoom rejects XSS, shell injection, non-HTTP schemes, and malformed URLs', () => {
      expect(parseInviteRoom('')).toBeNull();
      expect(parseInviteRoom('   ')).toBeNull();
      expect(parseInviteRoom('https://example.com/')).toBeNull();
      expect(parseInviteRoom('https://example.com/#?room=ABCD2')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=<script>alert(1)</script>')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=%3Cimg%20src=x%20onerror=alert(1)%3E')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=ABCD2;rm%20-rf%20/')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=$(whoami)')).toBeNull();
      expect(parseInviteRoom('https://example.com/?room=ABCD2%00')).toBeNull();
      expect(parseInviteRoom('javascript:alert(1)?room=ABCD2')).toBeNull();
      expect(parseInviteRoom('data:text/html,<script>?room=ABCD2')).toBeNull();
      expect(parseInviteRoom('http://[::1')).toBeNull();
    });

    test('sanitizes player names and codes against HTML tags, control chars, and length limits', () => {
      expect(sanitizePlayerName('  <b>Alice\u0000\n</b>  ')).toBe('bAlice/b');
      expect(sanitizePlayerName('Nguyễn Văn A')).toBe('Nguyễn Văn A');
      expect(sanitizePlayerName('X'.repeat(MAX_NAME_LENGTH + 15))).toHaveLength(MAX_NAME_LENGTH);
      expect(sanitizeInviteInput('  \u0007<script>hi</script>  ')).toBe('scripthi/script');

      let state = createInviteEntryState();
      state = setInviteName(state, '<script>alert(1)</script>ExtraLongName');
      expect(state.name).not.toContain('<');
      expect(state.name).not.toContain('>');
      expect(state.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);

      state = setInviteCode(state, '<ab-c d2>\u0000');
      expect(state.code).toBe('ABCD2');
      expect(state.code).toHaveLength(CODE_LENGTH);
    });
  });
});
