import { describe, expect, it } from 'vitest';

import {
  AssignedEmployee,
  ProjectStatus,
  TaskGroup,
  TaskIdSchema,
} from '../src/schema.js';

describe('@atelier/shared — schema', () => {
  it('ProjectStatus accepts 6 status labels', () => {
    expect(ProjectStatus.parse('準備中')).toBe('準備中');
    expect(ProjectStatus.parse('完了')).toBe('完了');
    expect(() => ProjectStatus.parse('unknown')).toThrow();
  });

  it('TaskGroup accepts 6 group letters', () => {
    expect(TaskGroup.parse('F')).toBe('F');
    expect(TaskGroup.parse('U-screen')).toBe('U-screen');
    expect(() => TaskGroup.parse('Z')).toThrow();
  });

  it('TaskIdSchema validates T-X-Y pattern', () => {
    expect(TaskIdSchema.parse('T-F-30')).toBe('T-F-30');
    expect(() => TaskIdSchema.parse('TF30')).toThrow();
    expect(() => TaskIdSchema.parse('T--30')).toThrow();
  });

  it('AssignedEmployee accepts 10 named employees', () => {
    for (const name of [
      'tony',
      'strange',
      'thor',
      'wanda',
      'vision',
      'tchalla',
      'steve',
      'natasha',
      'peter',
      'jarvis',
    ]) {
      expect(AssignedEmployee.parse(name)).toBe(name);
    }
    expect(() => AssignedEmployee.parse('unknown')).toThrow();
  });
});
