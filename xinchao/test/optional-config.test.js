import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('新增主动提示、念头罐和脉默认关闭，各开关可独立启用', () => {
  const keys = ['PULSE', 'DRIVE_POOL', 'DRIVE_PROMPTS_ENABLED', 'DRIVE_PROMPT_DAY_MAX'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    let config = loadConfig();
    assert.equal(config.pulse.enabled, false);
    assert.equal(config.bridge.drivePoolEnabled, false);
    assert.equal(config.bridge.drivePromptsEnabled, false);
    process.env.PULSE = 'true';
    process.env.DRIVE_POOL = 'true';
    process.env.DRIVE_PROMPTS_ENABLED = 'true';
    process.env.DRIVE_PROMPT_DAY_MAX = '0';
    config = loadConfig();
    assert.equal(config.pulse.enabled, true);
    assert.equal(config.bridge.drivePoolEnabled, true);
    assert.equal(config.bridge.drivePromptsEnabled, true);
    assert.equal(config.bridge.drivePromptDayMax, 0);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
