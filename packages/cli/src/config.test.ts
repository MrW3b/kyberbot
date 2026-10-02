import { describe, it, expect, afterEach } from 'vitest';
import { parseDuration, getServerHost, isLoopbackHost, urlHost } from './config.js';

describe('isLoopbackHost', () => {
  it('recognises loopback names and addresses', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) expect(isLoopbackHost(h)).toBe(true);
  });

  it('rejects wildcard and LAN addresses', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.20']) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('getServerHost', () => {
  const saved = process.env.KYBERBOT_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.KYBERBOT_HOST;
    else process.env.KYBERBOT_HOST = saved;
  });

  it('defaults to loopback', () => {
    delete process.env.KYBERBOT_HOST;
    expect(getServerHost()).toBe('127.0.0.1');
  });

  it('treats a blank value as unset', () => {
    process.env.KYBERBOT_HOST = '   ';
    expect(getServerHost()).toBe('127.0.0.1');
  });

  it('honours KYBERBOT_HOST, trimmed', () => {
    process.env.KYBERBOT_HOST = ' 0.0.0.0 ';
    expect(getServerHost()).toBe('0.0.0.0');
  });
});

describe('urlHost', () => {
  it('shows wildcard binds as localhost', () => {
    expect(urlHost('0.0.0.0')).toBe('localhost');
    expect(urlHost('::')).toBe('localhost');
  });

  it('keeps specific IPv4 addresses and names', () => {
    expect(urlHost('127.0.0.1')).toBe('127.0.0.1');
    expect(urlHost('192.168.1.20')).toBe('192.168.1.20');
    expect(urlHost('localhost')).toBe('localhost');
  });

  it('brackets IPv6 literals', () => {
    expect(urlHost('::1')).toBe('[::1]');
  });
});

describe('parseDuration', () => {
  it('should parse seconds', () => {
    expect(parseDuration('5s')).toBe(5_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1s')).toBe(1_000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('should parse days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('30')).toThrow('Invalid duration');
    expect(() => parseDuration('30x')).toThrow('Invalid duration');
    expect(() => parseDuration('m30')).toThrow('Invalid duration');
  });
});
