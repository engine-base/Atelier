'use client';

import * as React from 'react';

import { DataDeletionForm } from './_components/DataDeletionForm';

export default function SPub04Page() {
  return (
    <div className="mx-auto w-full max-w-2xl px-md py-lg">
      <DataDeletionForm onSubmit={async () => undefined} />
    </div>
  );
}
