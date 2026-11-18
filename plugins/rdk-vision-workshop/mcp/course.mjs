import { readFileSync } from 'node:fs';

const skill = new URL('../skills/rdk-vision-workshop/', import.meta.url);
export const plan = JSON.parse(readFileSync(new URL('assets/course-plan.json', skill), 'utf8'));
export const guideMarkdown = readFileSync(new URL('references/course-runbook.md', skill), 'utf8');
export const tuningHandoffMarkdown = readFileSync(new URL('references/tuning-handoff.md', skill), 'utf8');
