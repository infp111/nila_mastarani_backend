// Builds the system prompt the AI tutor receives for a session.
const list = (arr) => (arr || []).map((p) => `- "${p.en}"${p.or ? ` (ଓଡ଼ିଆ: ${p.or})` : ''}${p.note ? ` — ${p.note}` : ''}`).join('\n');
const parse = (v) => { if (!v) return []; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return []; } };

export function buildSystemPrompt({ basePrompt, course, lesson, learnerName }) {
  const parts = [basePrompt.trim()];
  if (learnerName) parts.push(`The learner's name is ${learnerName}. Use it warmly now and then.`);

  if (course) {
    parts.push(`\nCOURSE: ${course.title}${course.title_odia ? ` (${course.title_odia})` : ''} — level: ${course.level}, category: ${course.category}.`);
    if (course.description) parts.push(`Course description: ${course.description}`);
    if (course.course_instructions) parts.push(`Course guidance: ${course.course_instructions}`);
  }

  if (lesson) {
    parts.push(`\nTODAY'S LESSON: ${lesson.title}${lesson.title_odia ? ` (${lesson.title_odia})` : ''}`);
    if (lesson.objective) parts.push(`Goal: ${lesson.objective}`);
    const kp = parse(lesson.key_phrases);
    if (kp.length) parts.push(`Key phrases to teach and practise, one at a time:\n${list(kp)}`);
    const vocab = parse(lesson.vocabulary);
    if (vocab.length) parts.push(`Vocabulary:\n${list(vocab)}`);
    if (lesson.roleplay_scenario) parts.push(`After practising the phrases, do this role-play: ${lesson.roleplay_scenario}`);
    if (lesson.tutor_instructions) parts.push(`Extra instructions: ${lesson.tutor_instructions}`);
    parts.push(`The lesson should take about ${lesson.duration_min || 10} minutes.`);
    parts.push('Lesson flow: 1) greet and explain today\'s goal in Odia, 2) teach each key phrase (model → Odia meaning → learner repeats → feedback), 3) role-play / free practice, 4) short recap in Odia.');
  } else {
    parts.push('\nFREE PRACTICE: There is no fixed lesson. Ask the learner in Odia what they want to practise (e.g. introductions, shopping, interview) and have a friendly guided conversation.');
  }
  return parts.join('\n');
}

export function kickoffText(lesson) {
  return lesson
    ? 'The learner has just joined. Greet them warmly in Odia and begin today\'s lesson.'
    : 'The learner has just joined for free practice. Greet them warmly in Odia and ask what they would like to practise.';
}
