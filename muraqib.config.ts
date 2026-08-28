/**
 * muraqib.config.ts, the only file you need to adapt per project.
 *
 * Setup:
 *   1. Set baseUrl to your live app URL
 *   2. Add flows that map to test files in tests/
 *   3. Set alerting.emailTo + emailFrom (verified Resend domain)
 *   4. Add ANTHROPIC_API_KEY + RESEND_API_KEY as GitHub secrets
 *   5. npm install + npx playwright install chromium
 *   6. Done
 */

import { config as loadDotenv } from "dotenv";
loadDotenv();

export interface FlowSpec {
  /** Unique name, used in reports and Claude's fix context */
  name: string;
  /** Spec filename in tests/ (without .spec.ts) */
  file: string;
  /** true = alert immediately on failure; false = include in weekly digest */
  critical: boolean;
  /** Short description for Claude when auto-fixing */
  description: string;
}

export interface MuraqibConfig {
  projectName: string;
  baseUrl: string;
  stagingUrl?: string;
  flows: FlowSpec[];
  alerting: {
    emailTo: string;
    resendKeyEnv?: string;
    emailFrom: string;
  };
  claudeIntegration: {
    autoOpenPR: boolean;
    /**
     * true = Claude's PR auto-merges when CI is green, no human review.
     * Only turn this on once you also have branch protection + required
     * status checks on main (see README "Auto-merge" section), CI passing
     * is not the same as the fix being correct. Default is false on purpose.
     */
    autoMerge: boolean;
    apiKeyEnv?: string;
  };
  selectors: {
    preferTestId: boolean;
    testIdAttribute?: string;
  };
}

const config: MuraqibConfig = {
  projectName: "my-saas",
  baseUrl: process.env.QA_BASE_URL || "https://your-app.com",

  flows: [
    {
      name: "auth",
      file: "auth",
      critical: true,
      description: "Login flow, user lands on dashboard after sign in.",
    },
    {
      name: "public-pages",
      file: "public-pages",
      critical: false,
      description: "Smoke check: all public routes return 200, no 5xx errors.",
    },
    {
      name: "checkout",
      file: "checkout",
      critical: true,
      description: "Pricing page loads, CTA visible, no undefined/NaN prices.",
    },
  ],

  alerting: {
    emailTo: "you@yourdomain.com",
    emailFrom: "muraqib@yourdomain.com",
    resendKeyEnv: "RESEND_API_KEY",
  },

  claudeIntegration: {
    autoOpenPR: true,
    autoMerge: false, // turn on only after reading the README's "Auto-merge" section
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },

  selectors: {
    preferTestId: true,
    testIdAttribute: "data-testid",
  },
};

export default config;
