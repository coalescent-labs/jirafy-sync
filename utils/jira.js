const _pRetry = require('p-retry')
const pRetry = typeof _pRetry === 'function' ? _pRetry : _pRetry?.default
const core = require('@actions/core')
const { parseChangelogForJiraTickets } = require('./jira-helper')
const { jiraHost, packageName, today, parseForWord, parseForVersion } = require('./jira-helper')

const options = {
  username: process.env.JIRA_USERNAME || core.getInput('jiraUsername'),
  token: process.env.JIRA_TOKEN || core.getInput('jiraToken'),
  host: jiraHost,
}

const fetchHeader = {
  Authorization: `Basic ${Buffer.from(`${options.username}:${options.token}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
}

/**
 * Calls the Jira REST API v2 (native fetch, TLS verified)
 * @param {String} method HTTP method
 * @param {String} path Path below /rest/api/2 (i.e /project/ABC)
 * @param {Object} [body] JSON body
 * @returns {Promise<object|null>} Parsed JSON, or null on an empty response; throws with .status on non-OK
 */
async function jiraRequest(method, path, body) {
  const res = await fetch(`https://${options.host}/rest/api/2${path}`, {
    method,
    headers: fetchHeader,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`Jira ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`)
    err.status = res.status
    throw err
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/**
 * Retries transient failures only: network errors, 429 and 5xx
 * @param {Function} fn
 * @returns {Promise<*>}
 */
function withRetry(fn) {
  return pRetry(fn, {
    retries: 2,
    shouldRetry: (err) => err.status === undefined || err.status === 429 || err.status >= 500,
  })
}

/**
 * Get Jira Issue
 * @param {String} issueNumber
 * @returns {Promise<object>} The issue object
 */
function getIssue(issueNumber) {
  return jiraRequest('GET', `/issue/${encodeURIComponent(issueNumber)}`)
}

/**
 * Get Jira version
 * @param {String} version Version id
 * @returns {Promise<object>} The version object
 */
function getVersion(version) {
  return jiraRequest('GET', `/version/${encodeURIComponent(version)}`)
}

/**
 * Get Jira release versions
 * @param {String} project Project key or id
 * @returns {Promise<object[]>} The project versions
 */
function getVersions(project) {
  return jiraRequest('GET', `/project/${encodeURIComponent(project)}/versions`)
}

/**
 * Get a project Id by Project Key
 * @param {String} key Jira Project Key (i.e JIRAFY)
 * @returns {Promise<string|undefined>} The project's id, undefined when the project cannot be resolved
 */
function getProjectIdByKey(key) {
  return withRetry(() => jiraRequest('GET', `/project/${encodeURIComponent(key.toUpperCase())}`))
    .then((response) => response.id)
    .catch((err) => {
      core.warning(`Could not resolve Jira project ${key}: ${err.message}`)
      return undefined
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
 * Creates a release version. An already existing version is not an error.
 * @param {Boolean} archived
 * @param {String} releaseDate
 * @param {String} name
 * @param {String} description
 * @param {String} projectId
 * @param {Boolean} released
 * @returns {Promise<object|undefined>} The created version, undefined when it already exists
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

  core.info(`Attempting to create Jira version: ${JSON.stringify(version)}`)

  try {
    return await withRetry(() => jiraRequest('POST', '/version', version))
  } catch (err) {
    if (err.status === 400 && /already exists/i.test(err.message)) {
      core.info(`Jira version ${version.name} already exists in project ${projectId}`)
      return undefined
    }
    throw err
  }
}

/**
 * Set Jira issue properties
 * @param {string} issueId
 * @param {Object|string} issueUpdate - A plain object, or a prebuilt JSON string
 * @returns {Promise<null>} Resolves on success; throws on non-OK status
 */
function setIssueProperties(issueId, issueUpdate) {
  const body = typeof issueUpdate === 'string' ? JSON.parse(issueUpdate) : issueUpdate
  return withRetry(() => jiraRequest('PUT', `/issue/${encodeURIComponent(issueId)}`, body))
}

/**
 * Get only fixVersions of an issue
 * @param {string} issueId
 * @returns {Promise<{fields?: {fixVersions?: Array<{name: string}>}}>}
 */
function getFixVersions(issueId) {
  return withRetry(() => jiraRequest('GET', `/issue/${encodeURIComponent(issueId)}?fields=fixVersions`))
}

/**
 * Adds the version to a ticket's fixVersions, keeping the existing ones
 * @param {String} ticket
 * @param {String} version
 */
async function addFixVersion(ticket, version) {
  const json = await getFixVersions(ticket)
  const currentFixVersions = (json && json.fields && json.fields.fixVersions) || []
  if (currentFixVersions.some((v) => v.name === version)) {
    core.info(`${ticket} already has fix version ${version}`)
    return
  }
  const fixVersions = [...currentFixVersions.map((v) => ({ name: v.name })), { name: version }]
  core.info(`Setting fix versions ${JSON.stringify(fixVersions)} on ${ticket}`)
  await setIssueProperties(ticket, { fields: { fixVersions } })
}

/**
 * Creates the version in every referenced project and adds it to the fixVersions of that project's tickets.
 * Unknown projects (i.e CVE-2026 taken for a ticket) and missing tickets are skipped with a warning.
 * @param {String} changelog Changelog
 * @param {String} version Release version
 * @returns {Promise<String[]>} Tickets that could not be updated because of an unexpected error
 */
async function createVersionAndUpdateFixVersions(changelog, version) {
  const tickets = parseChangelogForJiraTickets(changelog)
  const projectOf = (ticket) => ticket.slice(0, ticket.lastIndexOf('-')).toUpperCase()
  const projects = [...new Set(tickets.map(projectOf).filter(Boolean))]
  version = parseForVersion(version)
  if (!version) {
    throw new Error('jiraVersion is not a valid version (expected vX.Y.Z)')
  }

  core.info(`Projects are: ${projects}`)
  core.info(`Tickets are: ${tickets}`)

  const failed = []
  for (const project of projects) {
    const projectId = await getProjectIdByKey(project)
    if (!projectId) {
      core.warning(`Skipping project ${project}: not a Jira project`)
      continue
    }
    await createVersion(false, today(), version, `Auto-generated by ${packageName}`, projectId, false)

    for (const ticket of tickets.filter((t) => projectOf(t) === project)) {
      try {
        await addFixVersion(ticket, version)
      } catch (err) {
        if (err.status === 404) {
          core.warning(`Skipping ${ticket}: issue not found or not visible`)
        } else {
          core.error(`Could not update ${ticket}: ${err.message}`)
          failed.push(ticket)
        }
      }
    }
  }
  return failed
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
