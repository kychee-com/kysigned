/**
 * F-45.4 / AC-274 — the public (fork-generic) FAQ carries the same #email-setup entry
 * as kysigned.com's: a fork's provider bounces link `/faq#email-setup-*` too. Static
 * HTML, read from disk. Outbound copy: no em or en dash.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(__dirname, '..', 'public', 'faq.html'), 'utf-8')
const start = html.indexOf('id="email-setup"')
const section = start < 0 ? '' : html.slice(start, html.indexOf('</section>', start))

describe('public FAQ #email-setup (F-45.4 / AC-274)', () => {
  it('has the entry and its three provider anchors', () => {
    for (const anchor of ['email-setup', 'email-setup-google', 'email-setup-microsoft', 'email-setup-other']) {
      expect(html, anchor).toMatch(new RegExp(`id="${anchor}"`))
    }
  })

  it('the signer part, the administrator section, the provider steps, the alias note', () => {
    for (const re of [
      /did everything right/i, /one-time/i, /Please turn on DKIM email signing/, /sign sooner/i,
      /Why turn this on \(even if you never use kysigned\)/i, /inbox/i, /impersonat/i, /DMARC/, /security (questionnaires|reviews)/i,
      /Google Admin console/, /Start authentication/, /Defender portal/, /CNAME/, /generate a key/i, /alias/i,
    ]) {
      expect(section, String(re)).toMatch(re)
    }
  })

  it('is operator-free and has no em or en dash', () => {
    expect(section.length).toBeGreaterThan(0)
    expect(section).not.toMatch(/kysigned\.com/i)
    expect(section.includes(String.fromCodePoint(0x2014)) || section.includes(String.fromCodePoint(0x2013))).toBe(false)
    expect(section).not.toMatch(/&mdash;|&ndash;/)
  })
})
