import type { DirectModelResource } from '../../src/framework/model-contract.ts';
import type { VocabWord } from '../../src/script.ts';

export const testModel: DirectModelResource & { actions: VocabWord[] } = {
  version: 1,
  kind: 'live2d-model',
  id: 'live2d-test',
  sourceId: 'fixture',
  sourceHash: '',
  title: 'Fixture',
  entry: { id: 'live2d-test' },
  appearance: [{ id: 'outfit', name: { zh: '装扮', en: 'Outfit' }, options: [
    { id: 'default', name: { zh: '默认', en: 'Default' } }, { id: 'alternate', name: { zh: '备用', en: 'Alternate' } },
  ] }],
  actions: [
    { id: 'thinking', kind: 'expression', names: { zh: ['思考'] }, about: { zh: '思考', en: 'thinking' }, seconds: 1 },
    { id: 'happy', kind: 'expression', names: {"zh":["开心","高兴"]}, about: {"zh":"眼睛弯成 ^ ^","en":"eyes curve into ^ ^"}, seconds: 0.9 },
    { id: 'wink', kind: 'expression', names: {"zh":["眨眼"]}, about: {"zh":"一只眼 ^","en":"one eye turns into ^"}, seconds: 0.9 },
    { id: 'jump', kind: 'motion', names: {"zh":["跳","跳起来"]}, about: {"zh":"原地起跳","en":"jumps on the spot"}, seconds: 1.2 },
    { id: 'nod', kind: 'motion', names: {"zh":["点头"]}, about: {"zh":"点两下头","en":"nods twice"}, seconds: 0.8 },
    { id: 'sit', kind: 'motion', names: {"zh":["坐下","坐"]}, about: {"zh":"坐下","en":"sits down"}, seconds: 0.8, lasting: true },
    { id: 'sleep', kind: 'motion', names: {"zh":["睡觉","睡"]}, about: {"zh":"坐着打盹","en":"dozes sitting down"}, seconds: 0.8, lasting: true },
  ],
  walk: true,
};
