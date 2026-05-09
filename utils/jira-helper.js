const core = require('@actions/core')
const packageName = require('../package.json').name
const jiraHost = core.getInput('jiraHost') || process.env.JIRA_HOST

/**
 * Parses a given changelog for Jira tickets
 * @param {string} changelog
 * @returns {string[]} Jira tickets parsed from the changelog (duplicates removed)
 */
function parseChangelogForJiraTickets(changelog) {
  let tickets

  try {
    const regex = /([A-Za-z0-9]+-\d+)(?=`)/g
    tickets = [...String(changelog).matchAll(regex)]
  } catch (error) {
    core.setFailed(error.message)
    return []
  }

  const duplicates = tickets.map((m) => m[0])
  return [...new Set(duplicates)]
}

/**
 * Parses a given string for words (alphabetic sequences)
 * @param {string} str String to parse
 * @returns {string[]} Parsed word(s)
 */
function parseForWord(str) {
  const regex = /\b[^\d\W]+\b/gm
  const parsedWords = []
  let m
  while ((m = regex.exec(str)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++
    }
    // m[0] is the matched word
    parsedWords.push(m[0])
  }
  return parsedWords
}

/**
 * Parses a given string for a version (expects a leading "v", e.g. v1.2.3[-prerelease][+build])
 * @param {string} str String to be parsed for version
 * @returns {string} Parsed version (full match) or empty string if none
 */
function parseForVersion(str) {
  try {
    // semantic version regex from https://semver.org ... prefixed with "v"
    const regex =
      /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/g
    const match = regex.exec(str)
    return match ? match[0] : ''
  } catch (error) {
    core.setFailed(error.message)
    return ''
  }
}

/**
 * Returns today's date
 * @returns {String} Todays date in yyyy-mm-dd format
 */
function today() {
  return new Date().toISOString().slice(0, 10)
}

module.exports = {
  jiraHost,
  parseChangelogForJiraTickets,
  parseForWord,
  parseForVersion,
  today,
  packageName,
}
