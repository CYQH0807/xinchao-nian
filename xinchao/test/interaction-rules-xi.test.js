import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_RULES, guardTag, loadInteractionRules } from '../src/interaction-rules.js';

const profilePath = fileURLToPath(new URL('../configs/interaction-rules.xi.json', import.meta.url));
const R = loadInteractionRules(profilePath);
const tag = (o) => ({ tone: 'warm', warmth: 0.6, tension: 0.1, sub: null, strength: null, closeness: null, who: null, ...o });

test('汐用配置只覆盖确认的六项，其余规则继承默认', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.deepEqual(Object.keys(profile).filter((key) => key !== '_说明').sort(),
    ['dailyBye', 'distress', 'harsh', 'heavy', 'shy', 'softAfterCloseMinutes']);
  for (const [key, length] of Object.entries({ heavy: 19, shy: 5, distress: 44, dailyBye: 32 })) {
    assert.equal(R.raw[key].length, length);
    assert.equal(new Set(R.raw[key]).size, length);
  }
  for (const key of ['fiction', 'longAway', 'accuse', 'closeness']) {
    assert.deepEqual(R.raw[key], DEFAULT_RULES[key]);
  }
  assert.deepEqual(R.raw.harsh, ['滚', '烦死', '别烦', '真的生气', '我生气了', '别跟我说话', '闭嘴', '讨厌死你', '分手']);
  assert.equal(R.softAfterCloseMs, 30 * 60_000);
});

test('普通叙述不因宽泛词提升重心动，明确亲密表达及模型重判断仍有效', () => {
  for (const text of ['这个问题永远存在', '后台一直在运行', '别走，我问个代码问题']) {
    assert.equal(guardTag(tag({ type: 'affection', strength: 'light' }), text, { rules: R }).strength, 'light');
  }
  assert.equal(guardTag(tag({ type: 'affection', strength: 'light' }), '有你真好', { rules: R }).strength, 'heavy');
  assert.equal(guardTag(tag({ type: 'intimacy', strength: 'heavy' }), '想一直和你在一起', { rules: R }).strength, 'heavy');
  assert.equal(guardTag(tag({ type: 'affection', strength: 'heavy' }), '亲亲', { rules: R }).strength, 'light');
  for (const text of ['老婆', '汐宝', '汐小宝', '想你', '要你']) {
    assert.equal(guardTag(tag({ type: 'affection', strength: 'light' }), text, { rules: R }).strength, 'heavy');
  }
  for (const text of ['抱', '亲亲', '这件事值得抱怨']) {
    assert.equal(guardTag(tag({ type: 'affection', strength: 'light' }), text, { rules: R }).strength, 'light');
  }
});

test('技术语境的偷偷不补认害羞，被夸、被说中及模型明确细项仍保留', () => {
  assert.equal(guardTag(tag({ type: 'affection' }), '我偷偷修了这个 Bug', { rules: R }).sub, null);
  for (const text of ['你是不是想我了', '真厉害', '被我说中了']) {
    assert.equal(guardTag(tag({ type: 'affection' }), text, { rules: R }).sub, '害羞');
  }
  assert.equal(guardTag(tag({ type: 'intimacy', sub: '害羞' }), '来抱抱', { rules: R }).sub, '害羞');
  assert.equal(guardTag(tag({ type: 'sharing' }), '你真厉害', { rules: R }).sub, null);
});

test('疲惫及工作压力可以支撑本人心疼，普通工作与虚构事件仍被拦截', () => {
  const empathy = tag({ type: 'empathy', sub: '心疼', closeness: 'her', who: '他' });
  for (const text of ['我今天有点累', '最近工作压力大，忙不过来', '最近身心俱疲', '累得不想动了',
    '今天心里烦', '烦得很', '最近没劲', '不想动了', '提不起劲']) {
    assert.equal(guardTag(empathy, text, { rules: R }).type, 'empathy');
  }
  for (const text of ['今天去上班', '我刚处理完一个任务', '小说里我很累', '我心疼你，自己只是有点累',
    '我烦你', '不要烦我', '小说里的他提不起劲']) {
    assert.equal(guardTag(empathy, text, { rules: R }).type, 'companionship');
  }
  assert.equal(guardTag(tag({ type: 'companionship' }), '今天有点累', { rules: R }).type, 'companionship');
});

test('工作、吃饭和临时离开不误作失落或被晾着，长期分别仍有效', () => {
  const recent = [{ type: 'companionship', at: Date.now() - 60_000 }];
  for (const text of ['我去上班了', '去开会了', '我去吃饭，晚点回来', '等我一下，去忙一会儿',
    '去午休一会', '睡一会', '趴一会', '起来再说', '起来聊', '我在路上', '到家说']) {
    assert.equal(guardTag(tag({ type: 'loss', sub: '失落' }), text, { rules: R }).type, 'companionship');
    assert.equal(guardTag(tag({ type: 'slighted', sub: '被晾着' }), text, { rules: R, recent }).type, 'companionship');
  }
  const away = guardTag(tag({ type: 'loss', sub: '分别' }), '去工作，要出差一周', { rules: R });
  assert.equal(away.type, 'loss');
  assert.equal(away.sub, '分别');
  assert.equal(guardTag(tag({ type: 'loss', sub: '失落' }), '我忘了答应陪你吃饭', { rules: R }).sub, '被忘');
});

test('弱冲突在亲近后三十分钟内豁免，亲昵昵称、边界和强冲突保持正确', () => {
  const now = Date.now();
  const weak = tag({ type: 'conflict', tension: 0.3 });
  const options = (minutes) => ({ rules: R, now, recent: [{ type: 'affection', at: now - minutes * 60_000 }] });
  assert.equal(guardTag(weak, '你真烦人', options(4)).type, 'affection');
  assert.equal(guardTag(weak, '你真烦人', options(20)).type, 'affection');
  assert.equal(guardTag(weak, '你真烦人', options(29)).type, 'affection');
  assert.equal(guardTag(weak, '你真烦人', options(30)).type, 'conflict');
  assert.equal(guardTag(weak, '你真烦人', options(31)).type, 'conflict');
  for (const text of ['小笨蛋', '傻瓜']) {
    assert.equal(R.harsh.test(text), false);
    assert.equal(guardTag(weak, text, options(20)).type, 'affection');
  }
  assert.equal(guardTag(weak, '闭嘴', options(1)).type, 'conflict');
  assert.equal(guardTag(tag({ type: 'conflict', tension: 0.6 }), '我不同意', options(20)).type, 'conflict');
  assert.equal(guardTag(weak, '小笨蛋', { rules: R, now }).type, 'conflict');
});

test('亲近后的别碰我及催睡不被狠话阻断，明确拒绝与其余八项继续阻断', () => {
  const now = Date.now();
  const options = { rules: R, now, recent: [{ type: 'intimacy', at: now - 20 * 60_000 }] };
  const weak = tag({ type: 'conflict', tension: 0.3 });
  for (const text of ['别碰我', '别说话，快睡', '别说话了，快睡', '不许说话']) {
    assert.equal(R.harsh.test(text), false);
    assert.equal(guardTag(weak, text, options).type, 'affection');
  }
  for (const text of ['别跟我说话', '滚', '烦死', '别烦', '真的生气', '我生气了', '闭嘴', '讨厌死你', '分手']) {
    assert.equal(guardTag(weak, text, options).type, 'conflict');
  }
  assert.equal(guardTag(tag({ type: 'conflict', tension: 0.8 }), '别碰我', options).type, 'conflict');
  assert.equal(guardTag(weak, '别碰我', { rules: R, now }).type, 'conflict');
});
