'use strict';

const AWS    = require('aws-sdk');
const gm     = require("gm").subClass({imageMagick : true });
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const async  = require('async');
const querystring = require('querystring');
const sanitizers = require('./sanitizers');

//
// OCR A Ticket Receipt using Tesseract
//

exports.handler = function(event, context) {

    var signedUrl;
    var token = '';

    process.env['PATH'] = process.env['PATH'] + ':' + process.env['LAMBDA_TASK_ROOT'];
    process.env['TESSDATA_PREFIX'] = process.env['LAMBDA_TASK_ROOT'];

    var backend_host             = process.env.AUTOLOTTO_BACKEND_HOST;
    var backend_username         = process.env.AUTOLOTTO_BACKEND_USERNAME;
    var backend_password         = process.env.AUTOLOTTO_BACKEND_PASSWORD;
    var api_token_endpoint       = process.env.AUTOLOTTO_TOKEN_ENDPOINT;
    var api_inventory_endpoint   = process.env.AUTOLOTTO_INVENTORY_ENDPOINT;
    var api_numbers_endpoint     = process.env.AUTOLOTTO_NUMBERS_ENDPOINT;
    var LOCAL_TEST               = process.env.LOCAL_TEST;

    AWS.config.update(
        {
            accessKeyId     : process.env.PS_AWS_ACCESS_KEY_ID,
            secretAccessKey : process.env.PS_AWS_SECRET_ACCESS_KEY,
            region          : ''
        }
   );
    var s3 = new AWS.S3({ apiVersion: '2006-03-01' });

    var bucket = event.Records[0].s3.bucket.name;
    var key    = event.Records[0].s3.object.key;

    var s3GetParams = {
        Bucket: bucket,
        Key: key,
    };

    var s3GetURLParams = {
        Bucket: bucket,
        Key: key,
        Expires: 63072000
    };

    var key_components = key.split('/');
    var state = key_components[0];
    if (LOCAL_TEST) {
        state = event.Records[0].s3.object.state;
    }
    //
    // The variables api_inventory_endpoint and api_numbers_endpoint will
    // have a place-holder $STATE$ - replace it with a specific state
    //
    if (api_inventory_endpoint && api_numbers_endpoint) {
        api_inventory_endpoint = api_inventory_endpoint.replace('$STATE$', state);
        api_numbers_endpoint   = api_numbers_endpoint.replace('$STATE$', state);
    }

    var num_components         = key_components.length;
    var image_name             = key_components[ num_components - 1];
    var ocr_output_file        = image_name.replace(/.jpg$/i , '');
    var local_image_path       = '/tmp/' + image_name + ".tif";
    var tmp_image_path         = '/tmp/tmp_' + image_name + ".tif";
    var local_output_path_base = '/tmp/' + ocr_output_file;
    var local_output_path      = '/tmp/' + ocr_output_file + '.txt';
    var state_config_file      = state + '/' + state + '_OCR_CONFIG.json';
    if (LOCAL_TEST) {
        state_config_file = "test_images/" + state_config_file;
    }
    var config_file_params = {
        Bucket: bucket,
        Key   : state_config_file

    };

    console.log('Bucket : ' + bucket);
    console.log('Key    : ' + key);
    console.log('State  : ' + state);
    console.log('Config : ' + state_config_file);
    console.log ('Backend Username : ' + backend_username);
    console.log ('Backend Password: '  + 'XXXXXX');
    console.log ('API Token Endpoint: ' + api_token_endpoint);
    console.log ('API Inventory Endpoint: ' + api_inventory_endpoint);
    console.log ('API Numbers Endpoint: ' + api_numbers_endpoint);

    async.waterfall([

        function init(callback) {
            console.log('In function init');
            console.log('Placeholder for future.');
            console.log('Test log message');
            callback(null);

        },

        function cleanup(callback) {
            return callback(null);
            fs.stat(local_image_path, function (err, stats) {
                console.log('cleanup: ' + stats);

                if (err) console.error(err);

                fs.unlink(local_image_path, function(err) {
                    if(err) console.log(err);
                    console.log('cleanup: ' + local_image_path + ' deleted successfully');
                });

            });

            fs.stat(local_output_path, function (err, stats) {
                console.log('cleanup: ' + stats);

                if (err) {
                    return console.error(err);
                }

                fs.unlink(local_output_path, function(err) {

                    if(err) return console.log(err);
                    console.log('cleanup: ' + local_output_path + ' deleted successfully');
                });

            });

            callback(null);

        },

        function config_exists(callback) {
            if (LOCAL_TEST) {
                callback(null);
            } else {
                s3.headObject(config_file_params, function (err, metadata) {
                    if (err && err.code === 'NotFound') {
	                    console.log('Config file: ' + state_config_file + ' Does not exist in bucket: ' + bucket);
                        console.log('Process exiting...');
                        process.exit(-1);
                    } else {
                        console.log('Config file: ' + state_config_file + ' Exists in bucket: ' + bucket);
                    }

                    callback(null);
                });
            }
        },

        function download_config(callback) {
            if (LOCAL_TEST) {
                var tmp_config_string = fs.readFileSync(state_config_file);
                var state_config = JSON.parse(tmp_config_string);
                callback(null, state_config);
            } else {
                s3.getObject(config_file_params, function(err, config_file_contents) {
                    console.log('download_config: Config file contents: ' + config_file_contents.Body.toString());
                    var tmp_config_string = config_file_contents.Body.toString();
                    var state_config = JSON.parse(tmp_config_string);
                    callback(err , state_config);
                });
            }
        },

        function validate_config(state_config , callback) {
            callback(null, state_config);
        },

        function download_image (state_config , callback) {
            if (LOCAL_TEST) {
                var image_contents = fs.readFileSync(key);
                var imageBuffer = new Buffer(image_contents, 'binary');
                callback(null, state_config, imageBuffer);
            } else {
                s3.getObject(s3GetParams, function(err, image_contents) {
                    signedUrl = s3.getSignedUrl('getObject', s3GetURLParams, null);
                    console.log('download_image: Signed url of image: ' + signedUrl);
                    var imageBuffer = new Buffer(image_contents.Body, 'binary');
                    console.log('download_image: Size of downloaded image: ' + imageBuffer.length);
                    callback(err , state_config , imageBuffer);
                });
            }
        },

        function crop_image(state_config , imageBuffer, callback) {
            if (state == "NH") {
                // Skip cropping if we're NH
                return gm(imageBuffer).write(local_image_path, function(err) {
                    callback(null);
                });
            }

            var croppedImageBuffer;
            var imageBufferBase64;

            console.log('crop_image: State:' + state_config.state);
            console.log('crop_image: X:' + state_config.plays_bounding_box.x);
            console.log('crop_image: Y:' + state_config.plays_bounding_box.y);
            console.log('crop_image: XSize:' + state_config.plays_bounding_box.xsize);
            console.log('crop_image: YSize:' + state_config.plays_bounding_box.ysize);

            var x     = state_config.plays_bounding_box.x;
            var y     = state_config.plays_bounding_box.y;
            var xsize = state_config.plays_bounding_box.xsize;
            var ysize = state_config.plays_bounding_box.ysize;

            console.log('crop_image: Output File:' + local_image_path);
            gm(imageBuffer).crop(xsize,ysize,x,y).write(local_image_path, function(err) {
                var stats = fs.statSync(local_image_path)
                var fileSizeInBytes = stats["size"]
                console.log('crop_image: Size of cropped image: ' + fileSizeInBytes);
                callback(null);
            });

        },

        function do_ocr(callback) {
            var sanitize = sanitizers[state];

            console.log("do_ocr: sanitizing image...");
            sanitize(local_image_path, tmp_image_path);

            // Upload the sanitized image to s3 for analysis
            fs.stat(tmp_image_path, function(err, file_info) {
		if (err) console.log(err);

                var bodyStream = fs.createReadStream( tmp_image_path );
                var params = {
                    Bucket: "autolotto-ops-scans-analysis",
                    Key:    state + "/" + tmp_image_path,
                    Body:   bodyStream,
                    ContentLength : file_info.size,
                };

                s3.putObject(params, function(err, data) {
                    if (err) {
                        console.log(err);
                    }
                    console.log("do_ocr: S3 Upload of Sanitized Data For Analays is Complete");

                    // Now run Tessaract
	            var tesseract_command = 'tesseract ' + tmp_image_path + ' ' +  local_output_path_base + ' -psm 6' + ' -l eng --user-words ./wordlist --user-patterns ./user_patterns config';

	            console.log('do_ocr: ' + tesseract_command);
	            var exec = require('child_process').exec;
	            exec(tesseract_command , function(err, stdout, stderr) {
	                console.log('do_ocr: stdout' + stdout);
	                console.log('do_ocr: stderr' + stderr);
	                callback(err);
	            });
                });
            });

        },

        function parse_ocr_results (callback) {
            const ocr_output = fs.readFileSync(local_output_path).toString().split("\n");
            console.log('raw ocr_results: ===============');
            console.log('raw ocr_results: ' + ocr_output);
            console.log('raw ocr_results: ===============');

            const ocr_raw_numbers = ocr_output
                  .map(line => line.replace(/ /g, '').match(/(\d{2})/g))
                  .filter(x => !!x)
                  .map(line => line.join(' '))
                  .join('\n');

            console.log('fixed ocr_results: ===============');
            console.log('fixed ocr_results: ' + ocr_raw_numbers);
            console.log('fixed ocr_results: ===============');

            var ocr_rows = ocr_raw_numbers.split('\n');
            var final_ocr_results = [ ];

            for(var i = 0; i < ocr_rows.length; i++) {
                ocr_rows[i] = ocr_rows[i].replace(/^[^0-9]/ , '');
                ocr_rows[i] = ocr_rows[i].replace(/^\t/ , '');
                ocr_rows[i] = ocr_rows[i].replace(/^\n/ , '');
                ocr_rows[i] = ocr_rows[i].replace(/^\s+/ , '');
                ocr_rows[i] = ocr_rows[i].replace(/\s+$/ , '');

                // ocr_rows[i] = ocr_rows[i].replace(/['`.,-_]+/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\‘/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\'/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\./g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\,/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\-/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\_/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\!/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\?/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\’/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\(/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/\)/g , '');

                ocr_rows[i] = ocr_rows[i].replace(/[pPbBeE:]+\d*/g , '');
                ocr_rows[i] = ocr_rows[i].replace(/[oO]/g , '0');
                ocr_rows[i] = ocr_rows[i].replace(/[iI]/g , '1');
                if (ocr_rows[i] === '') continue;
                final_ocr_results.push(ocr_rows[i]);

            }

            fs.writeFileSync(local_output_path + ".fixed", final_ocr_results.join("\n"));
            callback(null , final_ocr_results);

        },

        function get_token (final_ocr_results, callback) {
            if (LOCAL_TEST) {
                callback(null, null, final_ocr_results);
                return;
            }

            var post_data = querystring.stringify({
                'username' : backend_username,
                'password' : backend_password,
                'state'    : state
            });

            var post_options = {
                host : backend_host,
                port : 80,
                path : api_token_endpoint,
                method : 'POST',
                headers : {
                    'Content-Type'   : 'application/x-www-form-urlencoded',
                    'Content-Length' : Buffer.byteLength(post_data)
                }
            };

            var token_results = '';
            var post_req1 = http.request(post_options, function(res) {
                res.on('data', function(d) {
                    token_results += d;

                });

                res.on('end', function(err) {
                    var parsed_chunk = JSON.parse(token_results);
                    token = parsed_chunk.token;
                    console.log('Backend API token: ' + token);
                    callback(null, token, final_ocr_results);
                });
            });

            post_req1.write(post_data);
            post_req1.end();
        },

        function update_receipt_url (token, final_ocr_results, callback) {
            if (LOCAL_TEST) {
                return callback(null, null, final_ocr_results);
            }

            var url_update_post_data = querystring.stringify({
                's3Url' : signedUrl
            });

            var url_update_post_options = {
                host : backend_host,
                port : 80,
                path : api_inventory_endpoint,
                method : 'POST',
                headers : {
                    'Authorization'  : "Bearer " + token,
                    'Content-Type'   : 'application/x-www-form-urlencoded',
                    'Content-Length' : Buffer.byteLength(url_update_post_data)
                }

            };

            var url_update_results = '';
            var post_req2 = http.request(url_update_post_options, function(res) {
                res.on('data', function(d) {
                    url_update_results += d;
                });

                res.on('end', function(err) {
                    var update_return = JSON.parse(url_update_results);
                    console.log('In update_receipt_url:'    + url_update_results);

                    var success = update_return.success;
                    var updatedAt = update_return.data.updatedAt;
                    var createdAt = update_return.data.createdAt;
                    var eventType = update_return.data.eventType;
                    var state     = update_return.data.state;
                    var draw      = update_return.data.draw;
                    var _id       = update_return.data._id;

                    console.log('Success: '   + success + "," + eventType + "," + state + "," + draw);
                    callback(null, token, final_ocr_results);
                });
            });

            post_req2.write(url_update_post_data);
            post_req2.end();

        },

        function update_receipt_numbers (token, final_ocr_results, callback) {
            if (LOCAL_TEST) {
                callback(null, null, final_ocr_results);
                return;
            }

            var numbers_update_post_data = JSON.stringify({
                's3Url' : signedUrl,
                'awsRequestId': context.awsRequestId,
                "numbers" : [
                    final_ocr_results[0].toString().trim().split(" ").map(Number),
                    final_ocr_results[1].toString().trim().split(" ").map(Number),
                    final_ocr_results[2].toString().trim().split(" ").map(Number),
                    final_ocr_results[3].toString().trim().split(" ").map(Number),
                    final_ocr_results[4].toString().trim().split(" ").map(Number)
                ]

            });

            var numbers_update_post_options = {
                host : backend_host,
                port : 80,
                path : api_numbers_endpoint,
                method : 'POST',
                headers : {
                    'Authorization'  : "Bearer " + token,
                    'Content-Type'   : 'application/json',
                    'Content-Length' : Buffer.byteLength(numbers_update_post_data)
                }

            };

            var numbers_update_results = '';
            var post_req3 = http.request(numbers_update_post_options, function(res) {

                res.on('data', function(d) {
                    numbers_update_results += d;
                });

                res.on('end', function(err) {
                    var counter = 1;
                    var numbers_return = JSON.parse(numbers_update_results);
                    async.forEach(numbers_return.data, function(item, callback) {

                        console.log(counter + ":update_receipt_numbers __v: " + item.__v);
                        console.log(counter + ":update_receipt_numbers updatedAt: " + item.updatedAt);
                        console.log(counter + ":update_receipt_numbers createdAt: " + item.createdAt);
                        console.log(counter + ":update_receipt_numbers eventType: " + item.eventType);
                        console.log(counter + ":update_receipt_numbers state: "     + item.state);
                        console.log(counter + ":update_receipt_numbers draw: "      + item.draw);
                        console.log(counter + ":update_receipt_numbers _id: "       + item._id);
                        console.log(counter + ":update_receipt_numbers numbers: "   + item.data.numbers);
                        console.log(counter + ":update_receipt_numbers s3Url: "     + item.data.s3Url);
                        counter++;

                    });

                    callback(null, token, final_ocr_results);
                });
            });

            post_req3.write(numbers_update_post_data);
            post_req3.end();
        },

        function end_call(token, final_ocr_results, callback) {
            console.log('end_call: ===============');
            console.log("Autolotto OCR Ticket Recognition Ended");
            callback(null);
        }

    ] , function(err) {
        if (err) {
            console.log(err);
        } else {
            console.log('End of autolottoOCRTicket function');
            if (context && context.done) {
                var img = "";
                if ("imagename" in event.Records[0].s3.object) {
                    img = event.Records[0].s3.object.imagename;
                    context.done(img);
                }
            }
        }
    });
}
