import { digest } from '../model.js';
import type { FixtureChecker } from '../profile-types.js';
import { bookingCheckSuite, checkerArchive, checkerDigest, fixtureDigest, FIXTURE_DEFINITION, type BookingOracle } from './booking-checker.js';

export const bookingFixtureChecker: FixtureChecker = {
  entrypoint: 'booking.mjs', oracleFormat: 'booking-oracle/1',
  archive: checkerArchive, digest: checkerDigest,
  fixtureDigest: oracle => fixtureDigest(oracle as BookingOracle),
  run(module, oracle) {
    const expected = (oracle as BookingOracle).expected;
    const checks = bookingCheckSuite(module.createBooking, module.config, expected, FIXTURE_DEFINITION);
    const app=module.createBooking();
    const observations: Record<string, any> = { checks, oracle_sha256: digest(oracle), first_hold: app.hold('resource', 'first'), competing_hold: app.hold('resource', 'second') };
    if(expected.enabled) {app.advance(expected.seconds-expected.lead_seconds-1);observations.before_reminder=app.state();app.advance(1);observations.reminder=app.state();app.advance(0);observations.repeat_tick=app.state();app.advance(expected.lead_seconds-1);observations.before_expiry=app.state();app.advance(1);}else app.advance(expected.seconds);
    observations.expired=app.state();observations.next_hold=app.hold('resource','next');
    return { checks, observations };
  }
};
