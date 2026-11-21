export type CharacterWardrobe = {
  axes: Array<{ id: string; name: Record<string, string>; options: Array<{id:string; name:Record<string,string>}> }>;
  presets: Array<{ id: string; name: Record<string, string>; pick?: Record<string, string> }>;
  current: string;
  active: boolean;
};

export function characterWardrobePicker(doc: Document, report: CharacterWardrobe, zh: boolean, change?: (value: string) => void) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const labelFor = (value: Record<string, string>, fallback: string) =>
    (zh ? value.zh : value.en) ?? Object.values(value)[0] ?? fallback;
  const element = doc.createElement('div');
  element.className = 'studio-character-wardrobe';
  let current = '';
  function field(title: string, values: Array<[string, string]>, selected: string) {
    const wrapper = doc.createElement('label');
    const select = doc.createElement('select');
    select.setAttribute('aria-label', title);
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

  const choices = report.axes.map(axis =>
    field(labelFor(axis.name, axis.id), axis.options.map(option => [option.id, labelFor(option.name, option.id)]),
      axis.options[0]?.id ?? ''));
  const defaults: Array<[string, string]> = [['', t('原始外观', 'Original appearance')]];
  defaults.push(...report.presets.map(preset => [preset.id, labelFor(preset.name, preset.id)] as [string, string]));
  if (choices.length) defaults.push(['__custom__', t('自选组合', 'Custom combination')]);
  const preset = field(t('选择装扮', 'Choose an outfit'), defaults, '');
  element.prepend(preset.parentElement!);
  function pick(value: string) {
    if (current === value) return;
    current = value;
    change?.(current);
  }
  function showChoices(custom: boolean) {
    for (const choice of choices) choice.parentElement!.hidden = !custom;
  }
  for (const choice of choices) choice.onchange = () => pick(choices.map(control => control.value).join('-'));
  preset.onchange = () => {
    if (preset.value === '__custom__') { showChoices(true); return; }
    const old = current;
    setValue(preset.value);
    if (current !== old) change?.(current);
  };
  function setValue(value: string) {
    current = value;
    const mode = defaults.some(([id]) => id === value) ? value : choices.length ? '__custom__' : '';
    preset.value = mode;
    const authored = report.presets.find(item => item.id === value)?.pick;
    const parts = value.split('-');
    choices.forEach((choice, index) => {
      choice.value = authored?.[report.axes[index].id] ?? parts[index] ?? '';
      if (!choice.value) choice.selectedIndex = 0;
    });
    showChoices(mode === '__custom__');
  }
  function label(value: string) {
    const named = defaults.find(([id]) => id === value);
    if (named) return named[1];
    const parts = value.split('-');
    return report.axes.map((axis, index) => {
      const option = axis.options.find(item => item.id === parts[index]);
      return option ? labelFor(option.name, option.id) : '';
    }).filter(Boolean).join(' · ') || value;
  }
  setValue(report.current);
  return { element, value: () => current, setValue, label };
}
