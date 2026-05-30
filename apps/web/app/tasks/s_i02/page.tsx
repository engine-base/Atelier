'use client';

import * as React from 'react';

import { TaskDetailTabs } from './_components/TaskDetailTabs';

export default function SI02Page() {
  return (
    <div className="mx-auto w-full max-w-5xl px-md py-lg">
      <TaskDetailTabs title="Sample Task" />
    </div>
  );
}
