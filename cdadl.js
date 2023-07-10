const https = require('https');
const { spawn } = require('child_process');
const moment = require('moment');
const fs = require('fs');
const util = require('util');
const Crawler = require("crawler");
const request = require('request').defaults({ jar: true });
const progress = require('request-progress');
const readlineSync = require('readline-sync');

let downloads = {};
let filenamePrefix = "";
let paramurls = [];
let savedResult = "";

function downloadMovie(movieURL, title = "") {
  if (!movieURL || movieURL === "" || movieURL.indexOf(".mp4") === -1) {
    console.log("Aborting. Invalid video URL:", movieURL);
    fs.writeFileSync('result.html', savedResult, { flags: 'w+' });
    return;
  }

  const startTime = process.hrtime();
  const fl = movieURL.split("?")[0].split("/").pop().trim();

  title = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const sanitizedTitle = filenamePrefix + title.replace(/[^a-z0-9]/gi, '.') + "." + fl.split("/").pop().trim();
  const outputFilename = sanitizedTitle.replace(/\.+/g, ".");
  console.log("Output file:", outputFilename);
  console.log("aria2c", movieURL, "-o", outputFilename);

  if (process.argv[process.argv.length - 1].includes("aria")) {
    console.log("Calling aria...");
    spawn('aria2c', [movieURL, "-o", outputFilename], {
      detached: true,
      shell: true
    });
    console.log("Goodbye...");
    return;
  }

  let fileSizeInBytes = 0;
  try {
    const stats = fs.statSync(outputFilename);
    fileSizeInBytes = stats.size;
  } catch (e) {}

  const headers = {
    'User-Agent': 'CDADL',
    'Cookie': '',
    'Accept-Ranges': 'bytes',
  };

  var dls = '';
  var keysSorted = '';

  request({
    url: movieURL,
    method: "HEAD",
    headers: headers
  }, function callback(err, inc, res) {
    if (inc == undefined) {
      console.log("inc:", inc);
      console.log("err:", err);
      process.exit();
    }
    const conlen = inc.headers['content-length'];
    if (fileSizeInBytes < conlen) {
      const rng = 'bytes=' + fileSizeInBytes + '-' + (conlen - 1);
      headers.Range = rng;

      progress(request({
          url: movieURL,
          headers: headers
        }), {
          throttle: 1000, // Throttle the progress event to 2000ms, defaults to 1000ms
          delay: 500, // Only start to emit after 1000ms delay, defaults to 0ms
          startSize: fileSizeInBytes,
          totalSize: conlen
        })
        .on('response', function(resp) {
          if (resp.statusCode != 200) {
            console.error("statusCode:", resp.statusCode);
          }
        })
        .on('progress', function(state) {
          const diffTime = process.hrtime(startTime);
          const ETA = diffTime[0] / state.size.transferred * (state.size.total - state.size.transferred);
          const formattedETA = "ETA " + moment("2015-01-01").startOf('day').seconds(ETA).format('H:mm:ss');

          downloads[outputFilename] = state;
          downloads[outputFilename].info =
            ("      " + ((fileSizeInBytes + state.size.transferred) * 100 / conlen).toFixed(2)).slice(-6) + "% " +
            ("               " + ((fileSizeInBytes + state.size.transferred) / 1024 / 1024).toFixed(1) + "/" +
            ((fileSizeInBytes + state.size.total) / 1024 / 1024).toFixed(1)).slice(-15) + "MB " +
            " @" + (state.speed / 1024).toFixed(1) + "kB/s " + formattedETA;
          downloads[outputFilename].startSize = fileSizeInBytes;
          const keysSorted = Object.keys(downloads).sort();
          const t = { rec: 0, tot: 0, per: 0 };
          let downloadStatus = "";
          for (let dls = 0; dls < keysSorted.length; dls++) {
            const curdown = downloads[keysSorted[dls]];
            process.stdout.clearLine();
            downloadStatus += "\x1b[2K" + curdown.info + "\t" + keysSorted[dls] + "\n";
            if (curdown.size) t.rec += curdown.size.transferred + curdown.startSize;
            if (curdown.size) t.tot += curdown.size.total + curdown.startSize;
          }
          t.per = ("   " + parseInt(t.rec * 100 / t.tot) * 1).substr(-3);
          if (dls > 1) {
            downloadStatus += "------------------------------------------------------------------------------------------------------------------\n";
            downloadStatus += (t.rec / 1024 / 1024).toFixed(2) + "/" + (t.tot / 1024 / 1024).toFixed(2) + "M \t" + t.per + "% TOTAL\n";
          }
          downloadStatus = downloadStatus.split("\n").map(s => s.substring(0, process.stdout.columns - 2)).join("\n");
          console.log(downloadStatus + '\x1b[' + ((downloadStatus.match(/\n/g) || []).length + 1) + 'A');
        })
        .on('error', function(err) {
          fs.writeFileSync('error', util.inspect(result, true, null), {
            flags: 'w+'
          });
          console.error("ERROR!", err);
        })
        .pipe(fs.createWriteStream(outputFilename, {
          flags: 'a'
        }))
        .on('close', function(err) {});
    } else {
      try {
        const stats = fs.statSync(outputFilename);
        fileSizeInBytes = stats.size;
        if (fileSizeInBytes < conlen) {
          console.log("\n\nDownload incomplete.");
          process.exit();
        }
      } catch (e) {
        console.log("\n\nError while fs.statSync()", outputFilename, e);
        process.exit();
      }

      console.log("\n\nDownload complete.");
      process.exit();
    }
  });
}

const c = new Crawler({
  userAgent: 'cdadl',
  encoding: null,
  maxConnections: 100,
  callback: function(error, result, done) {
    const $ = result.$;
    savedResult = result.body;

    try {
      console.log("Fetching: " + result.uri);
      const title = $("title").text();
      console.log("Title:    " + title);

      const playerDataJSON = $("div[player_data]").attr("player_data") || "";
      if (playerDataJSON == "") {
        console.error("player_data JSON not found at " + result.uri);
        return;
      }
      const playerData = JSON.parse(playerDataJSON);
      if (!playerData || !playerData.video || !playerData.video.qualities) throw "player_data has no qualities";
      const qs = playerData.video.qualities;
      const formats = Object.keys(qs).concat(Object.keys(qs).map(k => qs[k]));
      console.log("Formats:  " + formats.join(" "));

      if (process.argv.slice().pop() == "info") return;
      if (formats.length == 0) throw "No formats found";

      let fmt = formats[formats.length - 1];
      if (process.argv.length > 3 && formats.includes(process.argv[3])) {
        fmt = process.argv[3];
      }
      fmt = Object.keys(qs).map(k => qs[k]).find(v => v == fmt || v == qs[fmt]);

      const data = `{"jsonrpc":"2.0","method":"videoGetLink","params":["${playerData.video.id}","${fmt}",${playerData.video.ts},"${playerData.video.hash2}",{}],"id":1}`;

      https.request({
          host: "www.cda.pl",
          port: 443,
          path: "/",
          method: 'POST',
          headers: { 'User-Agent': 'Chrome' }
        },
        res => {
          let responseData = "";
          res.on('data', d => {
            responseData += d.toString();
          });
          res.on('end', () => {
            try {
              const response = JSON.parse(responseData);
              if (response.result.status != "ok") {
                console.error("-------------------");
                console.error(res.req._header + data);
                console.error("-------------------");
                console.error(responseData);
                console.error("-------------------");
                throw "videoGetLink status not ok";
              }
              downloadMovie(response.result.resp, title);
            } catch (error) {
              console.error("Error parsing videoGetLink response:", error);
            }
          });
        })
        .on('error', error => {
          throw "videoGetLink error " + error;
        })
        .end(data);
    } catch (ex) {
      console.error("Unexpected error occurred, see result.html and investigate the website");
      fs.writeFileSync('result.html', result.body, { flags: 'w+' });
      console.error(ex);
      process.exit();
    }
  }
});

if (process.argv.length < 3) {
  console.log("Syntax: cdadl URL[ URL2 URL3 ... ] [format] [filename-prefix] [aria|info]");
  process.exit();
}

filenamePrefix = process.argv.slice(2).filter(p => !(p.startsWith("http") || p == "aria" || p == "info" || p == "-")).pop() || "";
paramurls = process.argv.slice(2).filter(p => /\d+/.test(p) || p.startsWith("http"));

if (process.argv[2] == "-") paramurls = paramurls.concat((fs.readFileSync(0) || "").toString().split("\n"));

if (paramurls.length > 0) {
  paramurls.forEach(p => {
    const s = p.split("/");
    const modifiedURL = "https://ebd.cda.pl/620x395/" + s.pop();
    c.queue(modifiedURL);
  });
} else {
  console.error("Error: No URLs or video IDs provided in the command line parameters!");
  process.exit();
}
