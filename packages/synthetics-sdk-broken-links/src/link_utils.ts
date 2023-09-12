// Copyright 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Browser, HTTPResponse, Page } from 'puppeteer';
import {
  BrokenLinksResultV1,
  BrokenLinksResultV1_BrokenLinkCheckerOptions,
  BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder,
  BrokenLinksResultV1_BrokenLinkCheckerOptions_PerLinkOption,
  BrokenLinksResultV1_SyntheticLinkResult,
  ResponseStatusCode,
  ResponseStatusCode_StatusClass,
  SyntheticResult,
} from '@google-cloud/synthetics-sdk-api';
import {
  BrokenLinkCheckerOptions,
  LinkOrder,
  StatusClass,
} from './broken_links';

/**
 * Represents an intermediate link with its properties.
 */
export interface LinkIntermediate {
  /**
   * The target URL of the link.
   */
  target_url: string;

  /**
   * The anchor text of the link.
   */
  anchor_text: string;

  /**
   * The HTML element of the link.
   */
  html_element: string;
}

/**
 * Represents common response properties for navigation (currently:`fetchLink()`
 *  and `navigate()`)
 */
export interface CommonResponseProps {
  /**
   * The response or error received during navigation. Essentially a wrapper
   * around `page.goto()`.
   */
  responseOrError: HTTPResponse | Error | null;

  /**
   * The start time of the link navigation.
   */
  linkStartTime: string;

  /**
   * The end time of the link navigation.
   */
  linkEndTime: string;
}

/**
 * Represents the response from a navigation attempt (currently: `navigate()`)
 */
export interface NavigateResponse extends CommonResponseProps {
  /**
   * Indicates whether the link passed successfully (taking into account per
   * link options, if present).
   */
  passed: boolean;

  /**
   * The number of navigation retries remaining for the link.
   */
  retriesRemaining: number;
}

/**
 * Checks if the given status code is passing w.r.t. expected status class or
 * code
 *
 * @param expected - The expected status code.
 * @param actual - The actual status code.
 * @returns Whether the status code is passing.
 */
export function checkStatusPassing(
  expected: ResponseStatusCode,
  actual: number
): boolean {
  if (typeof expected?.status_value === 'number') {
    return expected?.status_value === actual;
  } else {
    switch (expected?.status_class) {
      case ResponseStatusCode_StatusClass.STATUS_CLASS_1XX:
        return actual >= 100 && actual <= 199;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_2XX:
        return actual >= 200 && actual <= 299;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_3XX:
        return actual >= 300 && actual <= 399;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_4XX:
        return actual >= 400 && actual <= 499;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_5XX:
        return actual >= 500 && actual <= 599;
      default:
        return false;
    }
  }
}

/**
 * Type guard function to check if an object is an instance of HTTPResponse.
 *
 * @param response - The object to be checked.
 * @returns `true` if the object is an instance of HTTPResponse, `false` otherwise.
 */
export function isHTTPResponse(
  response: HTTPResponse | Error | null
): response is HTTPResponse {
  return (
    response !== null && typeof response === 'object' && 'status' in response
  );
}

/**
 * Determines whether navigating from the current URL to the target URL
 * requires navigating to a blank page. This prevents Puppeteer errors caused by
 * navigating from one URL to the same URL with a different anchor part (will
 * normally return `null`).
 *
 * @param current_url - The current URL in the browser.
 * @param target_url - The target URL
 * @returns True if navigating requires a blank page, false otherwise.
 * @example
 * const currentUrl = 'http://example.com/page1#section1';
 * const targetUrl = 'http://example.com/page1#section2';
 * const needsBlankPage = shouldGoToBlankPage(currentUrl, targetUrl); // true
 */
export function shouldGoToBlankPage(
  current_url: string,
  target_url: string
): boolean {
  // Check if the target URL contains an anchor (#) and if the current URL
  // includes the same base URL (excluding the anchor part)
  return (
    target_url.includes('#') &&
    current_url.includes(target_url.substring(0, target_url.indexOf('#')))
  );
}

/**
 * Parses an array of followed BrokenLinksResultV1_SyntheticLinkResult's and
 * aggregates statistics into a single BrokenLinksResultV1 object.
 *
 * @param followed_links - An array of BrokenLinksResultV1_SyntheticLinkResult
 *                         containing link results.
 * @returns An aggregated BrokenLinksResultV1 containing overall statistics of
 *          the parsed links.
 */
function parseFollowedLinks(
  followed_links: BrokenLinksResultV1_SyntheticLinkResult[]
) {
  const broken_links_result: BrokenLinksResultV1 = {
    link_count: 0,
    passing_link_count: 0,
    failing_link_count: 0,
    unreachable_count: 0,
    status_2xx_count: 0,
    status_3xx_count: 0,
    status_4xx_count: 0,
    status_5xx_count: 0,
    options: {} as BrokenLinksResultV1_BrokenLinkCheckerOptions,
    origin_link_result: {} as BrokenLinksResultV1_SyntheticLinkResult,
    followed_link_results: [],
  };

  for (const link of followed_links) {
    link.is_origin
      ? (broken_links_result.origin_link_result = link)
      : broken_links_result.followed_link_results.push(link);

    broken_links_result.link_count = (broken_links_result.link_count ?? 0) + 1;

    if (link.link_passed) {
      broken_links_result.passing_link_count =
        (broken_links_result.passing_link_count ?? 0) + 1;
    } else {
      broken_links_result.failing_link_count =
        (broken_links_result.failing_link_count ?? 0) + 1;
    }

    switch (Math.floor(link.status_code! / 100)) {
      case 2:
        broken_links_result.status_2xx_count =
          (broken_links_result.status_2xx_count ?? 0) + 1;
        break;

      case 3:
        broken_links_result.status_3xx_count =
          (broken_links_result.status_3xx_count ?? 0) + 1;
        break;

      case 4:
        broken_links_result.status_4xx_count =
          (broken_links_result.status_4xx_count ?? 0) + 1;
        break;

      case 5:
        broken_links_result.status_5xx_count =
          (broken_links_result.status_5xx_count ?? 0) + 1;
        break;

      default:
        // Handle other status codes if needed
        broken_links_result.unreachable_count =
          (broken_links_result.unreachable_count ?? 0) + 1;
        break;
    }
  }

  return broken_links_result;
}

/**
 * Creates a SyntheticResult object representing the result of a broken link
 * synthetic execution.
 *
 * @param start_time - The start time of the synthetic test in ISO format.
 * @param options - The BrokenLinkCheckerOptions used for the test.
 * @param followed_links - An array of BrokenLinksResultV1_SyntheticLinkResult representing followed links.
 * @returns A SyntheticResult object containing the broken links result, runtime metadata, start time, and end time.
 */
export function createSyntheticResult(
  start_time: string,
  runtime_metadata: { [key: string]: string },
  options: BrokenLinksResultV1_BrokenLinkCheckerOptions,
  followed_links: BrokenLinksResultV1_SyntheticLinkResult[]
): SyntheticResult {
  // Create BrokenLinksResultV1 by parsing followed links and setting options
  const broken_links_result: BrokenLinksResultV1 =
    parseFollowedLinks(followed_links);
  broken_links_result.options = options;

  // Create SyntheticResult object
  const synthetic_result: SyntheticResult = {
    synthetic_broken_links_result_v1: broken_links_result,
    runtime_metadata: runtime_metadata,
    start_time: start_time,
    end_time: new Date().toISOString(),
  };

  return synthetic_result;
}

/**
 * Opens a new Puppeteer page within the provided browser instance, disables caching, and returns the created page.
 *
 * @param browser - The Puppeteer browser instance in which to open a new page.
 * @returns A Promise that resolves with the newly created Puppeteer page or
 *          rejects if an error occurs during page creation.
 * @throws {Error} If an error occurs while opening a new page, it throws an
 *                 error with an appropriate message.
 */
export async function openNewPage(browser: Browser) {
  try {
    const page = await browser.newPage();
    page.setCacheEnabled(false);
    return page;
  } catch (pageError) {
    if (pageError instanceof Error) process.stderr.write(pageError.message);
    throw new Error('An error occurred while opening a new puppeteer.Page.');
  }
}

/**
 * Closes the provided Puppeteer browser instance and handles any errors
 * gracefully. No error is thrown as even if this errors we do not need to fail
 * the entire execution as Cloud Functions will handle the cleanup.
 *
 * @param browser - The Puppeteer browser instance to close.
 */
export async function closeBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch (err) {
    if (err instanceof Error) process.stderr.write(err.message);
  }
}

/**
 * Closes the provided Puppeteer pages handles any errors
 * gracefully. No error is thrown as even if this errors we do not need to fail
 * the entire execution as Cloud Functions will handle the cleanup.
 *
 * @param browser - The Puppeteer browser instance to close.
 */
export async function closePagePool(pagePool: Page[]) {
  try {
    // Close all pages in the pool
    await Promise.all(pagePool.map(async (page) => await page.close()));
  } catch (err) {
    if (err instanceof Error) process.stderr.write(err.message);
  }
}

/**
 * If the `link_order` is set to `RANDOM`, the links will be shuffled randomly.
 * Otherwise, the links will be copied without shuffling. Truncate to
 * `link_limit` regardless
 *
 * @param links - The array of links to process.
 * @param link_limit - The maximum number of links to retain.
 * @param link_order - Whether or not to shuffle links (enum value).
 * @returns A new array of links that have been truncated based on the `link_limit`.
 */
export function shuffleAndTruncate(
  links: LinkIntermediate[],
  link_limit: number,
  link_order: BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder
): LinkIntermediate[] {
  // shuffle links if link_order is `RANDOM` and truncate to link_limit

  // Shuffle the links if link_order is RANDOM, or copy the original array
  const linksToFollow =
    link_order === BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder.RANDOM
      ? [...links].sort(() => Math.random() - 0.5)
      : [...links];

  // Truncate the processed array to match the link_limit
  return linksToFollow.slice(0, link_limit! - 1);
}