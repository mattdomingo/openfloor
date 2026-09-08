import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("expands a populated pre-v2 database without rewriting historical runs or decisions", () => {
  const result = execFileSync("python3", ["-c", String.raw`
import sqlite3, json, pathlib
c = sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
entries = json.loads(pathlib.Path('drizzle/meta/_journal.json').read_text())['entries']
for entry in entries:
    if entry['idx'] < 48:
        c.executescript(pathlib.Path('drizzle', entry['tag']+'.sql').read_text())
def insert(table, **values):
    for column in c.execute('PRAGMA table_info('+table+')'):
        if column[3] and column[4] is None and column[1] not in values:
            values[column[1]] = 1 if column[2] == 'INTEGER' else 'fixture'
    c.execute('INSERT INTO '+table+' ('+','.join(values)+') VALUES ('+','.join('?' for _ in values)+')', list(values.values()))
insert('users', id='user')
insert('sessions', id='session')
insert('floor_agents', id='agent', session_id='session', created_by='user', owner_user_id='user', state='created')
insert('floor_queue_items', id='queue', session_id='session', status='blocked')
insert('repository_connections', id='connection', session_id='session', connected_by='user', status='ready')
insert('repository_candidates', id='candidate', session_id='session', connection_id='connection', created_by='user', status='active')
insert('agent_runs', id='source', session_id='session', queue_item_id='queue', agent_id='agent', candidate_id='candidate', created_by='user', status='conflicted')
insert('agent_runs', id='resolver', session_id='session', queue_item_id='queue', agent_id='agent', candidate_id='candidate', created_by='user', status='failed', attempt=2)
insert('merge_conflict_cases', id='case', session_id='session', source_run_id='source', latest_source_run_id='source', status='awaiting_input')
insert('merge_conflict_attempts', id='attempt', case_id='case', run_id='resolver', launch_kind='manual')
insert('merge_conflict_questions', id='question', case_id='case', requested_by_run_id='resolver', question='Keep both?', answer='Yes', answered_by='user', answered_at=1)
insert('merge_conflict_selections', id='selection', case_id='case', snapshot_run_id='resolver', path='src/shared feature 日本語.ts', hunk_index=0, choice='both', selected_by='user')
tables = ['users','sessions','floor_agents','floor_queue_items','repository_connections','repository_candidates','agent_runs','merge_conflict_cases','merge_conflict_attempts','merge_conflict_questions','merge_conflict_selections']
before = {table: ([row[1] for row in c.execute('PRAGMA table_info('+table+')')], c.execute('SELECT * FROM '+table).fetchall()) for table in tables}
for entry in entries:
    if entry['idx'] >= 48:
        c.executescript(pathlib.Path('drizzle', entry['tag']+'.sql').read_text())
for table, (columns, rows) in before.items():
    assert c.execute('SELECT '+','.join(columns)+' FROM '+table).fetchall() == rows, table
assert not c.execute('PRAGMA foreign_key_check').fetchall()
assert c.execute('SELECT mode, snapshot_id, proposal_id FROM merge_conflict_cases').fetchone() == ('prepare', None, None)
assert c.execute('SELECT execution_mode, snapshot_id, proposal_id FROM merge_conflict_attempts').fetchone() == ('ai', None, None)
print('Historical rows preserved; foreign keys valid; legacy decisions unapproved.')
`], { encoding: "utf8" });
  expect(result).toContain("Historical rows preserved; foreign keys valid; legacy decisions unapproved.");
});
