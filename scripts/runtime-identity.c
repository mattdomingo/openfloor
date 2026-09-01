#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROVIDER_USER "openfloor-provider"
#define WORKSPACE_USER "openfloor-workspace"
#define WORKSPACE_SRT_SETTINGS "/tmp/openfloor/workspace-srt-settings.json"
#define SRT_BINARY "/opt/openfloor/node_modules/.bin/srt"
#define REAL_BWRAP "/usr/bin/bwrap"
#define REAL_SHELL "/bin/bash"

static void fail(const char *message) {
  fprintf(stderr, "openfloor runtime identity: %s: %s\n", message, strerror(errno));
  exit(126);
}

static void fail_message(const char *message) {
  fprintf(stderr, "openfloor runtime identity: %s\n", message);
  exit(126);
}

static struct passwd *required_user(const char *name) {
  struct passwd *entry = getpwnam(name);
  if (entry == NULL) fail_message("required container user is missing");
  return entry;
}

static void drop_to(uid_t uid, gid_t gid, const char *user, int lock_privileges) {
  if (setgroups(0, NULL) != 0) fail("could not clear supplementary groups");
  if (setresgid(gid, gid, gid) != 0) fail("could not set runtime group");
  if (setresuid(uid, uid, uid) != 0) fail("could not set runtime user");
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail("could not disable process inspection");
  if (lock_privileges && prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("could not disable privilege gain");
  if (setenv("USER", user, 1) != 0 || setenv("LOGNAME", user, 1) != 0) fail("could not set runtime identity environment");
  umask(0002);
}

struct saved_env {
  const char *name;
  char *value;
};

static const char *workspace_env_names[] = {
  "CI", "COLORTERM", "FORCE_COLOR", "LANG", "LANGUAGE", "NO_COLOR",
  "OLDPWD", "TERM", "TZ", "NODE_CHANNEL_FD", NULL
};

static void install_workspace_environment(void) {
  struct saved_env saved[32];
  size_t count = 0;
  for (const char **name = workspace_env_names; *name != NULL; name++) {
    const char *value = getenv(*name);
    if (value != NULL) {
      saved[count].name = *name;
      saved[count].value = strdup(value);
      if (saved[count].value == NULL) fail("could not copy safe environment");
      count++;
    }
  }
  for (char **entry = environ; entry != NULL && *entry != NULL; entry++) {
    if (strncmp(*entry, "LC_", 3) == 0 && count < 31) {
      const char *equals = strchr(*entry, '=');
      if (equals == NULL) continue;
      size_t name_length = (size_t)(equals - *entry);
      char *name = strndup(*entry, name_length);
      char *value = strdup(equals + 1);
      if (name == NULL || value == NULL) fail("could not copy locale environment");
      saved[count].name = name;
      saved[count].value = value;
      count++;
    }
  }
  if (clearenv() != 0) fail("could not clear inherited environment");
  if (setenv("PATH", "/workspace/repository/node_modules/.bin:/opt/openfloor/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1) != 0 ||
      setenv("HOME", "/tmp/openfloor/workspace-home", 1) != 0 ||
      setenv("SHELL", REAL_SHELL, 1) != 0 ||
      setenv("TMPDIR", "/tmp", 1) != 0) {
    fail("could not create workspace environment");
  }
  char cwd[PATH_MAX];
  if (getcwd(cwd, sizeof(cwd)) != NULL && setenv("PWD", cwd, 1) != 0) fail("could not set workspace directory");
  for (size_t index = 0; index < count; index++) {
    if (setenv(saved[index].name, saved[index].value, 1) != 0) fail("could not restore safe environment");
    free((void *)saved[index].value);
  }
}

static size_t quoted_length(const char *value) {
  size_t length = 2;
  for (const char *cursor = value; *cursor != '\0'; cursor++) length += *cursor == '\'' ? 4 : 1;
  return length;
}

static char *quote_command(char *const arguments[]) {
  size_t length = 1;
  for (size_t index = 0; arguments[index] != NULL; index++) length += quoted_length(arguments[index]) + 1;
  char *command = calloc(length, 1);
  if (command == NULL) fail("could not allocate sandbox command");
  char *out = command;
  for (size_t index = 0; arguments[index] != NULL; index++) {
    if (index > 0) *out++ = ' ';
    *out++ = '\'';
    for (const char *cursor = arguments[index]; *cursor != '\0'; cursor++) {
      if (*cursor == '\'') {
        memcpy(out, "'\\''", 4);
        out += 4;
      } else {
        *out++ = *cursor;
      }
    }
    *out++ = '\'';
  }
  *out = '\0';
  return command;
}

static void run_workspace_command(char *const arguments[]) {
  char *command = quote_command(arguments);
  char *const srt_arguments[] = {
    "srt", "-s", WORKSPACE_SRT_SETTINGS, "-c", command, NULL
  };
  execv(SRT_BINARY, srt_arguments);
  fail("could not start workspace sandbox");
}

int main(int argc, char **argv) {
  if (argc < 2) fail_message("missing command");
  const char *program = strrchr(argv[0], '/');
  program = program == NULL ? argv[0] : program + 1;

  struct passwd *provider = required_user(PROVIDER_USER);
  uid_t provider_uid = provider->pw_uid;
  gid_t provider_gid = provider->pw_gid;
  struct passwd *workspace = required_user(WORKSPACE_USER);
  uid_t workspace_uid = workspace->pw_uid;
  gid_t workspace_gid = workspace->pw_gid;
  uid_t caller = getuid();

  if (strcmp(program, "openfloor-provider-exec") == 0) {
    if (caller != 0 && caller != provider_uid) fail_message("provider launcher called by unexpected user");
    // Provider children must still be able to cross the setuid workspace
    // launcher. PR_SET_NO_NEW_PRIVS is therefore applied only after that
    // transition, never to the provider process that invokes it.
    drop_to(provider_uid, provider_gid, PROVIDER_USER, 0);
    execvp(argv[1], &argv[1]);
    fail("could not start provider process");
  }

  if (caller != 0 && caller != provider_uid && caller != workspace_uid) {
    fail_message("workspace launcher called by unexpected user");
  }
  install_workspace_environment();
  drop_to(workspace_uid, workspace_gid, WORKSPACE_USER, 1);

  if (strcmp(program, "openfloor-workspace-bwrap") == 0) {
    char **arguments = calloc((size_t)argc + 1, sizeof(char *));
    if (arguments == NULL) fail("could not allocate bubblewrap arguments");
    arguments[0] = "bwrap";
    for (int index = 1; index < argc; index++) arguments[index] = argv[index];
    execv(REAL_BWRAP, arguments);
    fail("could not start workspace bubblewrap");
  }

  if (strcmp(program, "openfloor-workspace-shell") == 0 || strcmp(program, "bash") == 0) {
    char **arguments = calloc((size_t)argc + 1, sizeof(char *));
    if (arguments == NULL) fail("could not allocate shell arguments");
    arguments[0] = (char *)REAL_SHELL;
    for (int index = 1; index < argc; index++) arguments[index] = argv[index];
    run_workspace_command(arguments);
  }

  if (strcmp(program, "openfloor-workspace-exec") != 0) fail_message("unknown launcher name");
  run_workspace_command(&argv[1]);
  return 126;
}
