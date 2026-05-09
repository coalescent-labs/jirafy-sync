const JiraClient = require('jira-client')
const _pRetry = require('p-retry')
const pRetry = typeof _pRetry === 'function' ? _pRetry : _pRetry?.default
const fetch = require('node-fetch')
const core = require('@actions/core')
const { parseChangelogForJiraTickets } = require('./jira-helper')
const { jiraHost, packageName, today, parseForWord, parseForVersion } = require('./jira-helper')

const options = {
  username: process.env.JIRA_USERNAME || core.getInput('jiraUsername'),
  token: process.env.JIRA_TOKEN || core.getInput('jiraToken'),
  host: jiraHost,
}

const jira = new JiraClient({
  protocol: 'https',
  host: options.host,
  username: options.username,
  password: options.token,
  apiVersion: '2',
  strictSSL: false,
})

const fetchHeader = {
  Authorization: `Basic ${Buffer.from(`${options.username}:${options.token}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
}

/**
 * Get Jira Issue
 * @param {String} issueNumber
 * @returns {Promise<object>} Resolves with the issue object (or logs error)
 */
function getIssue(issueNumber) {
  return jira
    .findIssue(issueNumber)
    .then((response) => console.log(response))
    .catch((err) => console.log(`${err}`))
}

/**
 * Get Jira version
 * @param {String} version
 * @returns {Promise<object>} Resolves with the version object (or logs error)
 */
function getVersion(version) {
  return jira
    .getVersion(version)
    .then((response) => console.log(response))
    .catch((err) => console.log(`${err}`))
}

/**
 * Get Jira release versions
 * @param {String} project
 * @returns {Promise<object>} Resolves with the version object (or logs error)
 */
function getVersions(project) {
  return jira
    .getVersions(project)
    .then((response) => console.log(response))
    .catch((err) => console.log(`${err}`))
}

/**
 * Get a project Id by Project Key
 * @param {String} key Jira Project Key (i.e JIRAFY)
 * @returns {Promise<string>} A Promise that resolves to the project's id
 */
function getProjectIdByKey(key) {
  return jira
    .getProject(key.toUpperCase())
    .then((response) => {
      return response.id
    })
    .catch((err) => {
      console.log(`${err}`)
      return err
    })
}

/**
 * Get a project name by jira ticket name
 * @param {string} ticket Parses Jira project name from jira ticket name
 * @returns {Array} Parsed project name
 */
function getProjectNameByTicket(ticket) {
  return parseForWord(ticket)
}

/**
 * Creates a release version
 * @param {Boolean} archived
 * @param {String} releaseDate
 * @param {String} name
 * @param {String} description
 * @param {String} projectId
 * @param {Boolean} released
 * @returns {object} Success response || error & status code
 */
async function createVersion(archived, releaseDate, name, description, projectId, released) {
  const version = {
    archived: archived || false,
    releaseDate: releaseDate || today(),
    name: name || 'Unnamed',
    description: description || 'An excellent version',
    projectId: projectId,
    released: released || false,
  }

  console.log('\x1b[32m%s\x1b[0m', `Attempting to create Jira version: ${name} in project: ${JSON.stringify(version)}`)

  return jira
    .createVersion(version)
    .then((response) => console.log(response))
    .catch((err) => console.log(`${err}`))
}

/**
 * Set Jira issue properties
 * @param {string} issueId
 * @param {Object|string} issueUpdate - A plain object that will be JSON.stringified, or a prebuilt JSON string
 * @returns {Promise<Response>} The fetch Response; throws on non-OK status
 */
async function setIssueProperties(issueId, issueUpdate) {
  const bodyData = typeof issueUpdate === 'string' ? issueUpdate : JSON.stringify(issueUpdate)
  return await fetch(`https://${options.host}/rest/api/2/issue/${issueId}`, {
    method: 'PUT',
    headers: fetchHeader,
    body: bodyData,
  })
    .then(async (response) => {
      console.log(`setIssueProperties -> ${response.status} ${response.statusText} ${response.url}`)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const err = new Error(`Jira update failed: ${response.status} ${response.statusText} ${text}`)
        err.status = response.status
        throw err
      }
      return response
    })
    .catch((err) => {
      console.log(err)
      throw err
    })
}

/**
 * Get only fixVersions of an issue and return parsed JSON
 * @param {string} issueId
 * @returns {Promise<{fields?: {fixVersions?: Array<{name: string}>}}>}
 */
async function getFixVersions(issueId) {
  const res = await fetch(`https://${options.host}/rest/api/2/issue/${issueId}?fields=fixVersions`, {
    method: 'GET',
    headers: fetchHeader,
  })
  console.log(`getFixVersions -> ${res.status} ${res.statusText} ${res.url}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`Jira get fixVersions failed: ${res.status} ${res.statusText} ${text}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 *
 * @param {String} changelog Changelog
 * @param {String} version Release version
 */
function createVersionAndUpdateFixVersions(changelog, version) {
  const tickets = parseChangelogForJiraTickets(changelog)
  const projects = [...new Set(tickets.flatMap((t) => getProjectNameByTicket(t)).filter(Boolean))]
  version = parseForVersion(version)

  console.log('\x1b[32m%s\x1b[0m', `Projects are: ${projects}`)
  console.log('\x1b[32m%s\x1b[0m', `Tickets are: ${tickets}`)

  try {
    projects.forEach(async (project) => {
      console.log('\x1b[32m%s\x1b[0m', `Attempting to create Jira version: ${version} in project: ${project}`)

      const projectId = await getProjectIdByKey(project)
      if (!projectId || typeof projectId !== 'string') {
        console.log('\x1b[31m%s\x1b[0m', `Could not resolve project id for key: ${project}. Skipping.`)
        return
      }
      await createVersion(false, today(), version, `Auto-generated by ${packageName}`, projectId, false)

      for (const ticket of tickets) {
        const json = await getFixVersions(ticket)
        console.log('\x1b[32m%s\x1b[0m', `json: ${JSON.stringify(json)}`)
        if (json.fields && json.fields.fixVersions) {
          const currentFixVersions = json.fields.fixVersions
          let fixVersions = []
          let versionExists = false
          currentFixVersions.every((v) => {
            if (v.name !== version) {
              fixVersions.push({ name: v.name })
            } else {
              versionExists = true
            }
            return !versionExists
          })
          if (!versionExists) {
            fixVersions.push({ name: version })
            // Prefer fields payload for broader compatibility
            const issueProperties = { fields: { fixVersions } }
            console.log(
              '\x1b[32m%s\x1b[0m',
              `Attempting to set issue properties: ${JSON.stringify(issueProperties)} for ticket: ${ticket}`
            )
            await pRetry(() => setIssueProperties(ticket, issueProperties), { retries: 2 })
          }
        } else {
          console.log('\x1b[32m%s\x1b[0m', `No fixVersions found for ticket: ${ticket}`)
        }
      }
    })
  } catch (err) {
    console.log(err)
  }
}

module.exports = {
  getIssue,
  getVersion,
  getVersions,
  createVersion,
  setIssueProperties,
  createVersionAndUpdateFixVersions,
  getProjectNameByTicket,
  getProjectIdByKey,
}
