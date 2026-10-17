process.env.JIRA_HOST = 'jira.example.net'
const chai = require('chai')
const { createVersionAndUpdateFixVersions } = require('../utils/jira')

// In-memory Jira: project ABC, issues ABC-1 (no fix versions) and ABC-2 (already on v1.0.0)
function mockJira() {
  const calls = []
  const issues = { 'ABC-1': [], 'ABC-2': [{ name: 'v1.0.0' }] }
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status })
  global.fetch = async (url, { method, body }) => {
    const path = new URL(url).pathname.replace('/rest/api/2', '')
    calls.push(`${method} ${path}`)
    let m
    if ((m = path.match(/^\/project\/(\w+)$/))) return m[1] === 'ABC' ? reply(200, { id: '10002' }) : reply(404, {})
    if (path === '/version')
      return reply(400, { errors: { name: 'A version with this name already exists in this project.' } })
    if ((m = path.match(/^\/issue\/([\w-]+)$/))) {
      if (!issues[m[1]]) return reply(404, {})
      if (method === 'GET') return reply(200, { fields: { fixVersions: issues[m[1]] } })
      issues[m[1]] = JSON.parse(body).fields.fixVersions
      return reply(204)
    }
    return reply(500, {})
  }
  return { calls, issues }
}

describe('Sync flow (mocked Jira)', () => {
  const realFetch = global.fetch
  after(() => (global.fetch = realFetch))

  it('skips CVE ids and unknown tickets, sets the fix version once per ticket', async () => {
    const { calls, issues } = mockJira()
    const changelog =
      '* bump a library for [[`CVE-2021`](https://jira.example.net/browse/CVE-2021)]-44228\n' +
      '* [[`ABC-1`](x), [`ABC-2`](x)] fix\n* [[`ABC-404`](x)] gone'
    const failed = await createVersionAndUpdateFixVersions(changelog, 'v1.0.0')

    chai.assert.deepEqual(failed, [])
    chai.assert.deepEqual(issues['ABC-1'], [{ name: 'v1.0.0' }])
    chai.assert.deepEqual(issues['ABC-2'], [{ name: 'v1.0.0' }])
    chai.assert.notInclude(calls.join(), 'CVE-2021?')
    chai.assert.equal(calls.filter((c) => c === 'PUT /issue/ABC-1').length, 1)
    chai.assert.notInclude(calls, 'PUT /issue/ABC-2')
  })

  it('reports tickets that fail for unexpected reasons', async () => {
    mockJira()
    const failing = global.fetch
    global.fetch = async (url, opts) =>
      opts.method === 'PUT' ? new Response(null, { status: 403 }) : failing(url, opts)
    const failed = await createVersionAndUpdateFixVersions('* [[`ABC-1`](x)] fix', 'v1.0.0')
    chai.assert.deepEqual(failed, ['ABC-1'])
  })
})
