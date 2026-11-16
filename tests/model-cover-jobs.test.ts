import { describe, expect, it, vi } from 'vitest';
import { createModelCoverJobs, type CoverRenderer } from '../src/live2d/model-cover-jobs.ts';
import { testModel } from './helpers/model.ts';

function setup() {
  const models = new Map(['first', 'second', 'with-cover'].map(id => [id, { ...testModel, id, cover:id === 'with-cover' }]));
  const started: Array<{ id:string; token:string; signal:AbortSignal }> = [];
  const render: CoverRenderer = (address, receipt, signal) => {
    const url = new URL(address);
    const token = new URLSearchParams(url.hash.slice(1)).get('capture')!;
    started.push({ id:url.searchParams.get('model')!, token, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
      void receipt.then(resolve, reject);
    });
  };
  const jobs = createModelCoverJobs({ origin:() => 'http://127.0.0.1:7800', model:id => models.get(id), render });
  return { jobs, started };
}

describe('automatic model covers', () => {
  it('renders missing covers serially and skips a supplied cover', async () => {
    const { jobs, started } = setup();
    try {
      jobs.start(['first', 'second', 'with-cover']);
      expect(jobs.enqueue('first')).toBe(false);
      await vi.waitFor(() => expect(started).toHaveLength(1));
      expect(jobs.state('second')?.phase).toBe('queued');
      expect(jobs.state('with-cover')).toBeUndefined();
      const { token } = started[0];
      expect(jobs.authorized('second', token)).toBe(false);
      expect(jobs.authorized('first', 'wrong token')).toBe(false);
      expect(jobs.authorized('first', token)).toBe(true);
      jobs.finish('first', token, { saved:true });
      await vi.waitFor(() => expect(started.map(job => job.id)).toEqual(['first', 'second']));
      expect(jobs.state('first')).toBeUndefined();
      jobs.finish('second', started[1].token, { saved:false, reason:'test failure' });
      await vi.waitFor(() => expect(jobs.state('second')).toEqual({ phase:'failed', reason:'test failure' }));
      expect(jobs.enqueue('second')).toBe(false);
      expect(jobs.enqueue('second', true)).toBe(true);
      await vi.waitFor(() => expect(started).toHaveLength(3));
      expect(jobs.authorized('second', started[1].token)).toBe(false);
    } finally { await jobs.stop(); }
    expect(started[2].signal.aborted).toBe(true);
  });

  it('does not let a removed job affect a later import of the same model', async () => {
    const { jobs, started } = setup();
    try {
      jobs.start(['first']);
      await vi.waitFor(() => expect(started).toHaveLength(1));
      jobs.cancel('first');
      expect(jobs.enqueue('first')).toBe(true);
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(jobs.state('first')?.phase).toBe('rendering');
      expect(jobs.authorized('first', started[0].token)).toBe(false);
      jobs.finish('first', started[1].token, { saved:true });
      await vi.waitFor(() => expect(jobs.state('first')).toBeUndefined());
    } finally { await jobs.stop(); }
  });
});
