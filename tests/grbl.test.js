const { parseRTStatus } = require('../src/grbl');

test('parseRTStatus', () => {
  const res = parseRTStatus('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>');

  expect(res).toEqual({
    Idle: [],
    MPos: [0, 0, 0],
    FS: [0, 0],
    WCO: [0, 0, 0],
  });
});
