'use client';

import * as React from 'react';

import { EmployeeEditor, type EmployeeValues } from './_components/EmployeeEditor';

const INITIAL: EmployeeValues = {
  display_name: 'Tony',
  role: 'engineer',
  system_prompt: 'You are a senior engineer.',
  archived: false,
};

export default function SC02Page() {
  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <EmployeeEditor employeeId="tony" defaultValues={INITIAL} onSubmit={async () => undefined} />
    </div>
  );
}
