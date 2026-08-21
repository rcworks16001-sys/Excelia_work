const bcrypt = require('bcryptjs');
const readline = require('readline');

// ── EXCELIA admin password hasher ──
// Standalone CLI tool, NOT part of the running server. Run locally:
//   node scripts/hash-password.js
// Prompts for a password at your own terminal (never sent anywhere), prints
// the resulting bcrypt hash — paste that into your .env as
// ADMIN_PASSWORD_HASH yourself. This script never sees or stores your
// plaintext password anywhere.

const promptPasswordMasked = (question) => new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let input = '';

    stdout.write(question);

    const isTTY = stdin.isTTY;
    if (isTTY) {
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
    }

    const onData = (chunk) => {
        const char = chunk.toString('utf8');
        switch (char) {
            case '\n':
            case '\r':
            case '': // Ctrl-D
                if (isTTY) stdin.setRawMode(false);
                stdin.removeListener('data', onData);
                stdout.write('\n');
                resolve(input);
                break;
            case '': // Ctrl-C
                stdout.write('\n');
                process.exit(1);
                break;
            case '': // Backspace
                if (input.length > 0) {
                    input = input.slice(0, -1);
                    stdout.write('\b \b');
                }
                break;
            default:
                input += char;
                stdout.write('*');
                break;
        }
    };

    stdin.on('data', onData);
});

const run = async () => {
    // Falls back to visible input if stdin isn't a real TTY (e.g. piped) —
    // masking only works interactively.
    const password = await promptPasswordMasked('Enter the admin password to hash: ');

    if (!password || !password.trim()) {
        console.error('No password entered — aborting.');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    console.log('\nADMIN_PASSWORD_HASH=' + hash);
    console.log('\nPaste the line above into your .env (as ADMIN_PASSWORD_HASH). Also set ADMIN_USERNAME to whatever username you want to log in with.');
    process.exit(0);
};

run();
