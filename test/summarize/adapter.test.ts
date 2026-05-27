import { describe, it, expect } from 'vitest';
import { fallbackSummarize } from '../../src/v2/summarize-adapter.js';
import type { EventRow } from '../../src/store/types.js';

function ev(
  seq: number,
  role: 'user' | 'assistant',
  content: string,
): EventRow {
  return { event_uid: `e${seq}`, session_id: 'S', seq, ts: '2024-01-01T00:00:00Z', role, content };
}

describe('fallbackSummarize', () => {
  it('empty array → empty string', () => {
    expect(fallbackSummarize([])).toBe('');
  });

  it('single user event → singular form', () => {
    expect(fallbackSummarize([ev(1, 'user', 'Hello world')])).toBe('Hello world — 1 exchange');
  });

  it('multiple events with a first user event → pseudo-title + plural count', () => {
    const events = [
      ev(1, 'user', 'What is the plan?'),
      ev(2, 'assistant', 'Here is the plan.'),
      ev(3, 'user', 'Thanks'),
    ];
    expect(fallbackSummarize(events)).toBe('What is the plan? — 3 exchanges');
  });

  it('first user event has multiline content → only first line used as title', () => {
    const events = [
      ev(1, 'user', 'First line\nSecond line\nThird line'),
      ev(2, 'assistant', 'Understood.'),
    ];
    expect(fallbackSummarize(events)).toBe('First line — 2 exchanges');
  });

  it('truncates title at 60 chars', () => {
    const longTitle = 'A'.repeat(80);
    expect(fallbackSummarize([ev(1, 'user', longTitle)])).toBe('A'.repeat(60) + ' — 1 exchange');
  });

  it('truncates title at exactly 60 chars (no overshoot)', () => {
    const exactly60 = 'B'.repeat(60);
    expect(fallbackSummarize([ev(1, 'user', exactly60)])).toBe('B'.repeat(60) + ' — 1 exchange');
  });

  it('no user-role events → degrades to first event first line + plural count', () => {
    const events = [
      ev(1, 'assistant', 'Hello from assistant'),
      ev(2, 'assistant', 'Another assistant line'),
      ev(3, 'assistant', 'Yet another'),
    ];
    expect(fallbackSummarize(events)).toBe('Hello from assistant — 3 exchanges');
  });

  it('no user-role, single assistant event → singular form', () => {
    expect(fallbackSummarize([ev(1, 'assistant', 'Just the bot')])).toBe('Just the bot — 1 exchange');
  });

  it('first assistant events precede first user event → user line still used as title', () => {
    const events = [
      ev(1, 'assistant', 'System init'),
      ev(2, 'user', 'My question'),
      ev(3, 'assistant', 'My answer'),
    ];
    expect(fallbackSummarize(events)).toBe('My question — 3 exchanges');
  });
});
