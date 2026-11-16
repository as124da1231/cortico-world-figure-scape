import { expect, it } from 'vitest';
import { workspaceHref } from '../src/framework/workspace.ts';

it('links to the native provider pages without patching the stock routes', () => {
  expect(workspaceHref('framework', 'appearance')).toBe('#/provider/world%3Adesktop-live2d-pet/framework?task=appearance');
  expect(workspaceHref('sound', 'listening')).toBe('#/provider/world%3Adesktop-live2d-pet/sound?task=listening');
});
