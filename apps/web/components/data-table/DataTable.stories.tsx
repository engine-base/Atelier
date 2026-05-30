/**
 * DataTable stories — T-I-20.
 */

import type { Meta, StoryObj } from '@storybook/react';

import { DataTable, type ColumnDef } from './DataTable';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

const cols: ColumnDef<Row>[] = [
  { id: 'name', header: '名前', cell: (r) => r.name },
  { id: 'count', header: '件数', cell: (r) => String(r.count), align: 'right' },
];

const meta: Meta<typeof DataTable<Row>> = {
  title: 'Components/DataTable',
  component: DataTable,
};
export default meta;

type Story = StoryObj<typeof DataTable<Row>>;

export const WithRows: Story = {
  args: {
    caption: 'サンプル一覧',
    columns: cols,
    rows: [
      { id: 'a', name: 'Alpha', count: 12 },
      { id: 'b', name: 'Beta', count: 7 },
    ],
    rowKey: (r: Row) => r.id,
  },
};

export const Loading: Story = {
  args: {
    caption: 'ローディング',
    columns: cols,
    rows: [],
    rowKey: (r: Row) => r.id,
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    caption: '空',
    columns: cols,
    rows: [],
    rowKey: (r: Row) => r.id,
    emptyMessage: 'データがありません',
  },
};
