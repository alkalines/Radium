-- Separate database for packages/server tests, so test runs never touch development data.
CREATE DATABASE radium_test OWNER radium;
