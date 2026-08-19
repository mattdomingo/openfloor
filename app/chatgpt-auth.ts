import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import {
  identityFromHeaders,
  localDevelopmentIdentity,
  type AuthenticatedIdentity,
} from "@/lib/identity";

const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

export type ChatGPTUser = AuthenticatedIdentity;

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  return identityFromHeaders(requestHeaders) ?? localDevelopmentIdentity(requestHeaders);
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  return `${appPath(SIGN_IN_PATH)}?return_to=${encodeURIComponent(appPath(safeRelativeReturnPath(returnTo)))}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  return `${appPath(SIGN_OUT_PATH)}?return_to=${encodeURIComponent(appPath(safeRelativeReturnPath(returnTo)))}`;
}

function appPath(path: string): string {
  return `${BASE_PATH}${path === "/" ? "" : path}` || "/";
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local" || isReservedAuthPath(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return pathname === SIGN_IN_PATH || pathname === SIGN_OUT_PATH || pathname === CALLBACK_PATH;
}
