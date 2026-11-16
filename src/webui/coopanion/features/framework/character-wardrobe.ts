export type CharacterWardrobe = {
  axes: Array<{ id: string; name: Record<string, string>; options: Array<{id:string; name:Record<string,string>}> }>;
  presets: Array<{ id: string; name: Record<string, string> }>;
  current: string;
  active: boolean;
};

export function characterWardrobePicker(doc: Document, report: CharacterWardrobe, zh: boolean, change?: (value: string) => void) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const labelFor = (value: Record<string, string>, fallback: string) =>
    (zh ? value.zh : value.en) ?? Object.values(value)[0] ?? fallback;
  const element = doc.createElement('div');
  element.className = 'studio-character-wardrobe';
  let current = report.current;
  function field(title: string, values: Array<[string, string]>, selected: string) {
    const wrapper = doc.createElement('label');
    const select = doc.createElement('select');
    for (const [id, title] of values) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = title;
      select.append(option);
    }
    select.value = selected;
    wrapper.append(title, select);
    element.append(wrapper);
    return select;
  }

  const choices = report.axes.map((axis, index) =>
    field(labelFor(axis.name, axis.id), axis.options.map(option => [option.id, labelFor(option.name, option.id)]),
      current.split('-')[index] ?? axis.options[0]?.id ?? ''));
  for (const choice of choices) if (!choice.value) choice.selectedIndex = 0;
  const defaults: Array<[string, string]> = [['', t('原始外观', 'Original appearance')]];
  defaults.push(...report.presets.map(preset => [preset.id, labelFor(preset.name, preset.id)] as [string, string]));
  if (choices.length) defaults.push(['__custom__', t('自选组合', 'Custom combination')]);
  const initial = defaults.some(([id]) => id === current) ? current : choices.length ? '__custom__' : '';
  const preset = field(t('选择装扮', 'Choose an outfit'), defaults, initial);
  element.prepend(preset.parentElement!);
  function pick(value: string) {
    current = value === '__custom__' ? choices.map(choice => choice.value).join('-') : value;
    for (const choice of choices) choice.parentElement!.hidden = value !== '__custom__';
    change?.(current);
  }
  for (const choice of choices) {
    choice.parentElement!.hidden = initial !== '__custom__';
    choice.onchange = () => pick('__custom__');
  }
  preset.onchange = () => pick(preset.value);
  function setValue(value: string) {
    current = value;
    const mode = defaults.some(([id]) => id === value) ? value : choices.length ? '__custom__' : '';
    preset.value = mode;
    const parts = value.split('-');
    choices.forEach((choice, index) => {
      choice.value = parts[index] ?? '';
      if (!choice.value) choice.selectedIndex = 0;
      choice.parentElement!.hidden = mode !== '__custom__';
    });
  }
  return { element, value: () => current, setValue };
}
