// Launch provenance is not evidence of the thread currently attached to a pane.
const currentThread = session => session.codexThreadId || session.resumeThreadId || null;
const matchesThread = (session, id) => currentThread(session) === id;
module.exports = { currentThread, matchesThread };
