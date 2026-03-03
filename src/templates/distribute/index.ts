import type { TemplateResult } from "../index.js";
import { waitlist } from "./waitlist.js";
import { welcome } from "./welcome.js";
import { signupNotification } from "./signup-notification.js";
import { signinNotification } from "./signin-notification.js";
import { campaignCreated } from "./campaign-created.js";
import { campaignStopped } from "./campaign-stopped.js";
import { userActive } from "./user-active.js";

export const templates: Record<string, (metadata?: Record<string, unknown>) => TemplateResult> = {
  waitlist,
  welcome,
  signup_notification: signupNotification,
  signin_notification: signinNotification,
  campaign_created: campaignCreated,
  campaign_stopped: campaignStopped,
  user_active: userActive,
};
