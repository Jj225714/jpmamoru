"""Local administrator CLI; access codes are revealed only at creation."""

import argparse
import getpass
import json
import os
import sys

from config import Config, DEFAULT_CONFIG, load_config, private_write, save_config
from state import State


def main(argv=None):
    if os.name == "posix":
        os.umask(0o077)
    parser = argparse.ArgumentParser(description="Private managed model gateway administration")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--origin", required=True)
    init.add_argument("--upstream-base-url", required=True)
    init.add_argument("--state-dir", default="/var/lib/aoweisi-model-gateway")
    create = commands.add_parser("create-code")
    create.add_argument("--name", required=True)
    create.add_argument("--output-file")
    create.add_argument("--image-limit", type=int)
    create.add_argument("--text-limit", type=int)
    disable = commands.add_parser("disable-code")
    disable.add_argument("--id", required=True)
    quota = commands.add_parser("set-quota")
    quota.add_argument("--id", required=True)
    quota.add_argument("--image-limit", type=int, required=True)
    quota.add_argument("--text-limit", type=int, required=True)
    commands.add_parser("list-codes", help="List principal IDs, names, enabled state and quotas; never codes or hashes")
    admin = commands.add_parser("set-rules-admin")
    admin.add_argument("--id", required=True)
    admin.add_argument("--enabled", choices=("true", "false"), required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            # getpass otherwise warns and falls back to echoed stdin: fail closed.
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("BM API key (hidden): ")
            config = Config(origin=args.origin, upstream_base_url=args.upstream_base_url,
                            api_key=key, state_dir=args.state_dir)
            save_config(config, args.config)
            print("Private configuration created.")
            return 0
        state = State(load_config(args.config))
        if args.command == "create-code":
            principal, code = state.create_code(args.name, args.image_limit, args.text_limit)
            result = json.dumps({"id": principal, "name": args.name, "code": code}, ensure_ascii=False) + "\n"
            if args.output_file:
                try:
                    private_write(args.output_file, result)
                except Exception:
                    state.disable(principal)
                    raise
                print("Access code written to private delivery file.")
            else:
                print(result, end="")
        elif args.command == "disable-code":
            state.disable(args.id)
            print("Access code disabled and sessions revoked.")
        elif args.command == "set-quota":
            state.set_quotas(args.id, args.image_limit, args.text_limit)
            print("Quotas updated.")
        elif args.command == "list-codes":
            print(json.dumps(state.list_principals(), ensure_ascii=False, indent=2))
        elif args.command == "set-rules-admin":
            state.set_rules_admin(args.id, args.enabled == "true")
            print("Rules administrator permission updated.")
        return 0
    except (Exception, KeyboardInterrupt):
        # No filenames, credentials, SQL parameters or exception values in output.
        print("Operation failed. Check local configuration, permissions and arguments.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
