#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROVIDER_USER "openfloor-provider"
#define BROKER_USER "openfloor-broker"
#define WORKSPACE_USER "openfloor-workspace"
#define WORKSPACE_SRT_SETTINGS "/tmp/openfloor/workspace-srt-settings.json"
#define SRT_BINARY "/opt/openfloor/node_modules/.bin/srt"
#define REAL_BWRAP "/usr/bin/bwrap"
#define REAL_SHELL "/bin/bash"
#define APPLY_SECCOMP_X64_SUFFIX "/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp"
#define APPLY_SECCOMP_ARM64_SUFFIX "/@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp"

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

static void drop_to(uid_t uid, gid_t gid, const char *user) {
  if (setgroups(0, NULL) != 0) fail("could not clear supplementary groups");
  if (setresgid(gid, gid, gid) != 0) fail("could not set runtime group");
  if (setresuid(uid, uid, uid) != 0) fail("could not set runtime user");
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail("could not disable process inspection");
  if (setenv("USER", user, 1) != 0 || setenv("LOGNAME", user, 1) != 0) fail("could not set runtime identity environment");
  umask(0002);
}

static void prepare_bwrap_root(void) {
  // The pinned bwrap's root path owns namespace setup. Model-selected code
  // never runs under this identity: bwrap's command is the fixed handoff
  // binary below, which irreversibly selects openfloor-workspace before the
  // validated apply-seccomp chain starts.
  if (setgroups(0, NULL) != 0) fail("could not clear supplementary groups");
  if (setresgid(0, 0, 0) != 0) fail("could not prepare bubblewrap group");
  if (setresuid(0, 0, 0) != 0) fail("could not prepare bubblewrap user");
  if (setenv("USER", "root", 1) != 0 || setenv("LOGNAME", "root", 1) != 0) {
    fail("could not set bubblewrap identity environment");
  }
  umask(0002);
}

static void handoff_to_workspace(uid_t uid, gid_t gid) {
  if (getuid() != 0 || geteuid() != 0) fail_message("workspace handoff called without root identity");
  if (setgroups(0, NULL) != 0) fail("could not clear handoff groups");
  if (prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0) != 0) fail("could not retain sandbox capability");
  if (setresgid(gid, gid, gid) != 0) fail("could not set handoff group");
  if (setresuid(uid, uid, uid) != 0) fail("could not set handoff user");

  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct data[2] = { { 0 } };
  data[CAP_SYS_ADMIN / 32].effective = 1U << (CAP_SYS_ADMIN % 32);
  data[CAP_SYS_ADMIN / 32].permitted = 1U << (CAP_SYS_ADMIN % 32);
  data[CAP_SYS_ADMIN / 32].inheritable = 1U << (CAP_SYS_ADMIN % 32);
  if (syscall(SYS_capset, &header, data) != 0) fail("could not narrow sandbox capability");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, CAP_SYS_ADMIN, 0, 0) != 0) {
    fail("could not pass sandbox capability");
  }
  if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) != 0) fail("could not lock sandbox capability");
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail("could not disable handoff inspection");
  if (setenv("USER", WORKSPACE_USER, 1) != 0 || setenv("LOGNAME", WORKSPACE_USER, 1) != 0) {
    fail("could not set handoff identity environment");
  }
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

static void run_workspace_command(char *const arguments[], uid_t broker_uid, gid_t broker_gid) {
  char *command = quote_command(arguments);
  char *const srt_arguments[] = {
    "srt", "-s", WORKSPACE_SRT_SETTINGS, "-c", command, NULL
  };
  // srt is trusted broker code. It must retain a non-workspace identity so
  // only its bwrap child can enter the setuid namespace launcher. The bwrap
  // launcher performs the final uid/gid drop after namespace setup.
  drop_to(broker_uid, broker_gid, BROKER_USER);
  execv(SRT_BINARY, srt_arguments);
  fail("could not start workspace sandbox");
}

static int is_forbidden_bwrap_option(const char *argument) {
  const char *forbidden[] = {
    "--uid", "--gid", "--cap-add", "--userns", "--userns2",
    "--userns-block-fd", "--unshare-user-try", "--disable-userns", "--assert-userns-disabled",
    "--args", "--share-net", NULL
  };
  for (const char **option = forbidden; *option != NULL; option++) {
    size_t length = strlen(*option);
    if (strcmp(argument, *option) == 0 ||
        (strncmp(argument, *option, length) == 0 && argument[length] == '=')) {
      return 1;
    }
  }
  return 0;
}

static int has_trusted_seccomp_command(int argc, char **argv, int separator) {
  if (argc != separator + 4 || strcmp(argv[separator + 2], "-c") != 0) return 0;
  const char *shell = strrchr(argv[separator + 1], '/');
  shell = shell == NULL ? argv[separator + 1] : shell + 1;
  if (strcmp(shell, "bash") != 0) return 0;
  const char *command = argv[separator + 3];
  const char *suffixes[] = { APPLY_SECCOMP_X64_SUFFIX, APPLY_SECCOMP_ARM64_SUFFIX, NULL };
  for (const char **suffix = suffixes; *suffix != NULL; suffix++) {
    if (strstr(command, *suffix) != NULL) return 1;
  }
  return 0;
}

static void run_workspace_bwrap(int argc, char **argv) {
  int separator = -1;
  int has_user_namespace = 0;
  int drops_all_capabilities = 0;
  int has_network_namespace = 0;
  int has_pid_namespace = 0;
  int has_private_proc = 0;
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--") == 0) {
      separator = index;
      break;
    }
    if (is_forbidden_bwrap_option(argv[index])) fail_message("forbidden bubblewrap identity option");
    if (strcmp(argv[index], "--unshare-user") == 0) has_user_namespace = 1;
    if (strcmp(argv[index], "--unshare-net") == 0) has_network_namespace = 1;
    if (strcmp(argv[index], "--unshare-pid") == 0) has_pid_namespace = 1;
    if (strcmp(argv[index], "--proc") == 0 && index + 1 < argc && strcmp(argv[index + 1], "/proc") == 0) {
      has_private_proc = 1;
    }
    if (strcmp(argv[index], "--cap-drop") == 0 && index + 1 < argc && strcmp(argv[index + 1], "ALL") == 0) {
      drops_all_capabilities = 1;
    }
  }
  if (separator < 0 || separator == argc - 1) fail_message("bubblewrap command separator is missing");
  if (!has_user_namespace || !drops_all_capabilities || !has_network_namespace ||
      !has_pid_namespace || !has_private_proc) {
    fail_message("bubblewrap identity policy is incomplete");
  }
  if (!has_trusted_seccomp_command(argc, argv, separator)) {
    fail_message("bubblewrap command is not guarded by apply-seccomp");
  }

  char **arguments = calloc((size_t)argc + 16, sizeof(char *));
  if (arguments == NULL) fail("could not allocate bubblewrap arguments");
  int out = 0;
  arguments[out++] = "bwrap";
  for (int index = 1; index < separator; index++) {
    // Ubuntu 22.04's bwrap 0.6.1 fails with EOVERFLOW when its setuid path
    // combines a non-root target uid with --unshare-user. The guarded helper
    // already gives bwrap real uid/gid = workspace and effective uid/gid =
    // root, so bwrap's native setuid mode owns namespace setup and drops to
    // a root-owned handoff. That handoff selects the outer workspace identity
    // before the nested seccomp helper applies no_new_privs.
    if (strcmp(argv[index], "--unshare-user") == 0) continue;
    if (strcmp(argv[index], "--cap-drop") == 0 && index + 1 < separator && strcmp(argv[index + 1], "ALL") == 0) {
      index++;
      continue;
    }
    arguments[out++] = argv[index];
  }
  arguments[out++] = "--cap-add";
  arguments[out++] = "CAP_SYS_ADMIN";
  arguments[out++] = "--cap-add";
  arguments[out++] = "CAP_SETUID";
  arguments[out++] = "--cap-add";
  arguments[out++] = "CAP_SETGID";
  arguments[out++] = "--";
  arguments[out++] = "/opt/openfloor/openfloor-workspace-handoff";
  for (int index = separator + 1; index < argc; index++) arguments[out++] = argv[index];
  arguments[out] = NULL;
  prepare_bwrap_root();
  execv(REAL_BWRAP, arguments);
  fail("could not start workspace bubblewrap");
}

int main(int argc, char **argv) {
  if (argc < 2) fail_message("missing command");
  const char *program = strrchr(argv[0], '/');
  program = program == NULL ? argv[0] : program + 1;

  struct passwd *provider = required_user(PROVIDER_USER);
  uid_t provider_uid = provider->pw_uid;
  gid_t provider_gid = provider->pw_gid;
  struct passwd *broker = required_user(BROKER_USER);
  uid_t broker_uid = broker->pw_uid;
  gid_t broker_gid = broker->pw_gid;
  struct passwd *workspace = required_user(WORKSPACE_USER);
  uid_t workspace_uid = workspace->pw_uid;
  gid_t workspace_gid = workspace->pw_gid;
  uid_t caller = getuid();

  if (strcmp(program, "openfloor-workspace-handoff") == 0) {
    handoff_to_workspace(workspace_uid, workspace_gid);
    execvp(argv[1], &argv[1]);
    fail("could not start sandboxed workspace command");
  }

  if (strcmp(program, "openfloor-provider-exec") == 0) {
    if (caller != 0 && caller != provider_uid) fail_message("provider launcher called by unexpected user");
    drop_to(provider_uid, provider_gid, PROVIDER_USER);
    execvp(argv[1], &argv[1]);
    fail("could not start provider process");
  }

  if (caller != 0 && caller != provider_uid && caller != broker_uid && caller != workspace_uid) {
    fail_message("workspace launcher called by unexpected user");
  }

  if (strcmp(program, "openfloor-workspace-bwrap") == 0) {
    // Model-selected commands already run as openfloor-workspace. They may
    // re-enter only the fixed-policy srt launcher, never choose privileged
    // bwrap mount or namespace arguments directly.
    if (caller == workspace_uid) fail_message("bubblewrap launcher called by workspace user");
    install_workspace_environment();
    run_workspace_bwrap(argc, argv);
  }

  install_workspace_environment();
  if (strcmp(program, "openfloor-workspace-shell") == 0 || strcmp(program, "bash") == 0) {
    char **arguments = calloc((size_t)argc + 1, sizeof(char *));
    if (arguments == NULL) fail("could not allocate shell arguments");
    arguments[0] = (char *)REAL_SHELL;
    for (int index = 1; index < argc; index++) arguments[index] = argv[index];
    run_workspace_command(arguments, broker_uid, broker_gid);
  }

  if (strcmp(program, "openfloor-workspace-exec") != 0) fail_message("unknown launcher name");
  run_workspace_command(&argv[1], broker_uid, broker_gid);
  return 126;
}
