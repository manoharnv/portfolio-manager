import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows } from './csv.js';

describe('parseCsvRows', () => {
  it('streams plain lines through the fast path', () => {
    expect(Array.from(parseCsvRows('a,b,c\n1,2,3\n'))).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF, a missing trailing newline and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps commas inside quoted fields and unescapes doubled quotes', () => {
    expect(parseCsv('"x, y",2,"say ""hi"""\n')).toEqual([['x, y', '2', 'say "hi"']]);
  });

  it('keeps newlines inside quotes and resumes on the right physical line', () => {
    expect(parseCsv('"multi\nline",1\nnext,2\n')).toEqual([
      ['multi\nline', '1'],
      ['next', '2'],
    ]);
  });

  it('mixes fast and quoted lines and matches parseCsv exactly', () => {
    const text = 'a,b,c\r\n"x, y",2,"z"\r\n\n1,2,3\n\r\nlast,row';
    const rows = Array.from(parseCsvRows(text));
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', '2', 'z'],
      ['1', '2', '3'],
      ['last', 'row'],
    ]);
    expect(parseCsv(text)).toEqual(rows);
  });

  it('drops blank lines but preserves empty fields', () => {
    expect(parseCsv('a,,c\n\n,\n1,2,\n')).toEqual([
      ['a', '', 'c'],
      ['', ''],
      ['1', '2', ''],
    ]);
    expect(parseCsv('""\n')).toEqual([]);
  });

  it('treats a quote after the first character of a field as a literal', () => {
    expect(parseCsv('5" pipe,1\n')).toEqual([['5" pipe', '1']]);
    expect(parseCsv('"quoted"tail,1\n')).toEqual([['quotedtail', '1']]);
  });

  it('swallows a stray CR inside an unquoted record with quotes elsewhere', () => {
    expect(parseCsv('"a",b\r\n')).toEqual([['a', 'b']]);
  });

  it('takes the rest of the file for an unterminated quote', () => {
    expect(parseCsv('a,"never closed\nmore')).toEqual([['a', 'never closed\nmore']]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});
