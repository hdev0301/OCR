'use strict';

const AWS    = require('aws-sdk');
const gm     = require("gm").subClass( {imageMagick : true } );
const fs     = require('fs');
const https  = require( 'https' );
const os     = require( 'os' );
const async  = require( 'async' );

//
// Version 0.1 - December 07, 2016
// somup@zensys.com
// First version of program to automate the OCR process using
// Google Cloud Vision API
//
// Renamed to ocr-google.js
//
// TODO TODO TODO TODO TODO TODO TODO TODO
// ===============================================
//
// (1) If the Lambda code is triggered due to a 'folder creation',
//     the program should identify that and skip processing (size of image
//     buffer should be 0)
//
// (2) If a number is recognized as 3 digits instead of 2 digits, do we
//     consider the first 2 or the last 2?
//
// (3) Move the image file to 'completed' bucket after OCR process
//
// (4) Call backend API to register the recognized numbers
//
// (5) Needs a lot more robust error checking.
//
// (6) Document - especially, the heuristics surrounding mis-recognitions and
//     special cases.
//
//

exports.handler = function( event, context ) {

   var signedUrl;

   // Async version

   console.log( 'Executing the async version of the OCR process' );

   var google_cloud_api_key = process.env.GOOGLE_CLOUD_API_KEY;

   AWS.config.update(
      { accessKeyId     : process.env.PS_AWS_ACCESS_KEY_ID,
        secretAccessKey : process.env.PS_AWS_SECRET_ACCESS_KEY,
        region          : ''
      }
   );
   var s3 = new AWS.S3( { apiVersion: '2006-03-01' } );

   var bucket = event.Records[0].s3.bucket.name;
   var key    = event.Records[0].s3.object.key;

   var params = {
      Bucket: bucket,
      Key: key
   };

   var key_components = key.split( '/' );
   var state = key_components[0];
   var state_config_file = state + '/' + state + '_OCR_CONFIG.json';

   var config_file_params = {

      Bucket: bucket,
      Key   : state_config_file

   };

   console.log( 'Bucket : ' + bucket );
   console.log( 'Key    : ' + key );
   console.log( 'State  : ' + state );
   console.log( 'Config : ' + state_config_file );

   async.waterfall( [

      function init( callback ) {

         console.log( 'In function init' );
         console.log( 'Placeholder for future' );
         callback( null );

      },

      function download_config( callback ) {

         // Download config file

         s3.getObject( config_file_params, function( err, config_file_contents ) {

            console.log( 'download_config: Config file contents: ' + config_file_contents.Body.toString( ) );
            var tmp_config_string = config_file_contents.Body.toString( );
            var state_config = JSON.parse( tmp_config_string );
            callback( err , state_config );

         });

      },

      function download_image ( state_config , callback ) {

         s3.getObject( params, function(err, image_contents ) {

            signedUrl = s3.getSignedUrl( 'getObject' , params, null );
            console.log( 'download_config: Signed url of image: ' + signedUrl );
            var imageBuffer = new Buffer( image_contents.Body, 'binary');
            console.log('download_image: Size of downloaded image: ' + imageBuffer.length);
            callback( err , state_config , imageBuffer );

         });

      },

      function crop_image( state_config , imageBuffer, callback ) {

         var croppedImageBuffer;
         var imageBufferBase64;

         console.log( 'crop_image: State:' + state_config.state );
         console.log( 'crop_image: X:' + state_config.plays_bounding_box.x);
         console.log( 'crop_image: Y:' + state_config.plays_bounding_box.y);
         console.log( 'crop_image: XSize:' + state_config.plays_bounding_box.xsize);
         console.log( 'crop_image: YSize:' + state_config.plays_bounding_box.ysize);

         var x     = state_config.plays_bounding_box.x;
         var y     = state_config.plays_bounding_box.y;
         var xsize = state_config.plays_bounding_box.xsize;
         var ysize = state_config.plays_bounding_box.ysize;

         gm(imageBuffer).crop(xsize,ysize,x,y).toBuffer( 'JPG' , function(err , croppedImageBuffer) {

            console.log('crop_image: Size of cropped image: ' + croppedImageBuffer.length);
            imageBufferBase64 = croppedImageBuffer.toString('base64');
            console.log('crop_image: Size of Base64 image: ' + imageBufferBase64.length);

            callback( err , imageBufferBase64 );

         });

      },

      function do_ocr( imageBufferBase64, callback ) {

         var json_request_object = JSON.stringify({
            "requests": [
                {
                   "image": {
                   "content": imageBufferBase64
                   },
                "features": [
                   {
                      "type": "TEXT_DETECTION"
                   }
                   ]
                }
               ]
             }
         );

         var postheaders = {

            'Content-Type'   : 'application/json',
            'Content-Control': 'no-cache',
            'Content-Length' : Buffer.byteLength(json_request_object, 'utf8' )
         };

         var optionspost = {

            host    : 'vision.googleapis.com',
            path    : '/v1/images:annotate?key=' + google_cloud_api_key,
            method  : 'POST',
            headers : postheaders,

         };

         var result_data = '';
         var reqPost = https.request( optionspost, function( res ) {

            res.on( 'data' , function( d ) {

               result_data += d;

            });

            res.on( 'end' , function( err ) {

               console.log( 'do_ocr: Cloud Vision API returned. ' );
               console.log( 'do_ocr: ' + result_data );
               callback( null , result_data );

            });


         });

         reqPost.write( json_request_object );
         reqPost.end( );

      },

      function parse_ocr_results ( result_data, callback ) {

         var ocr_results = JSON.parse(result_data);
         var ocr_raw_numbers = 
             ocr_results['responses'][0]['textAnnotations'][0]['description'];

         console.log( 'parse_ocr_results: ===============');
         console.log( 'parse_ocr_results: ' + ocr_raw_numbers );
         console.log( 'parse_ocr_results: ===============');

         var ocr_rows = ocr_raw_numbers.split('\n');
         var ocr_rows_merged  = [ ];
         var final_ocr_results = [ ];

         //
         // If there is a line with /^ ?P?B ?[:-] in the beginning,
         // it belongs to the previous row. Merge. 
         // If a line contains just 2 digits, merge.
         // Keep track of how many rows were merged.
         //
                
         var merged_count = 0;

         for ( var i = 0; i < ocr_rows.length; i++ ) {

            // Remove any special characters
            ocr_rows[i] = ocr_rows[i].replace( /[,-]/ig , '' );
            ocr_rows[i] = ocr_rows[i].replace( /\\/ig , '' );

            if ( ocr_rows[i].match(/^ ?P?B ?[:-] /) ) {

               if ( i !== 0 ) {

                  var a = ocr_rows[i];
                  ocr_rows_merged[i-1] += ' ' + a;
                  ocr_rows_merged[i] = undefined;
                  merged_count++;
                  continue;

               }

            }
            else if ( ocr_rows[i].match(/^ ?\d{2} ?$/) ) {

               if ( i !== 0 ) {

                  var b = ocr_rows[i];
                  ocr_rows_merged[i-1] += ' ' + b;
                  ocr_rows_merged[i] = undefined;
                  continue;

               }

            }

            ocr_rows_merged.push( ocr_rows[i] );

         }

         //
         // Cleanup the merged rows (remove PB, :, spaces etc.)
         // case insensitive
         //

         for ( i = 0; i < 5 + merged_count; i++ ) {

            if ( ocr_rows_merged[i] === undefined ) {

               continue;

            }

            ocr_rows_merged[i] = 
               ocr_rows_merged[i].replace( /P?B? ?[:-]? ?/ig , '' );

         }

         //
         // If the numbers are not correctly recognized 
         // (incorrect spacing) merge and split them back into pairs
         //
                
         for ( i = 0; i < 5 + merged_count; i++ ) {

            if ( ocr_rows_merged[i] === undefined ) {

               continue;

            }

            var tmp_numbers = ocr_rows_merged[i].split(' ');

            if ( tmp_numbers.length != 6 ) {

               var tmp_string = tmp_numbers.join( "" );
               var new_numbers = tmp_string.match( /.{2}/g );
               ocr_rows_merged[i] = new_numbers.slice( 0 , 6 ).join(" ");

            }

         }

         for ( i = 0; i < 5 + merged_count; i ++ ) {

            if ( ocr_rows_merged[i] === undefined ) {

               continue;

            }

            final_ocr_results.push( ocr_rows_merged[i] );

         }
         callback( null , final_ocr_results );

      },

      function zapier_trigger( final_ocr_results, callback ) {

         console.log( 'zapier_trigger:===============');

         var date_string = 
            new Date().toISOString( ).replace( /T/ , ' ' ).replace( /\..+/ , '' );

         for ( var i = 0; i < final_ocr_results.length; i++ ) {

            var ocr_results = final_ocr_results[i];
            console.log( 'zapier_trigger: ' + ocr_results );

            var zapier_request_object = JSON.stringify({

               ocrresult : { 
                  date      : date_string,
                  url       : signedUrl,
                  ocroutput : ocr_results }
               }

            );

            var zapier_postheaders = {

               'Content-Type'   : 'application/json',
               'Content-Control': 'no-cache',
               'Content-Length' : Buffer.byteLength( zapier_request_object, 'utf8' )

            };

            var zapier_optionspost = {

               host    : process.env.ZAPIER_WEBHOOK_HOST,
               path    : process.env.ZAPIER_WEBHOOK_PATH,
               method  : 'POST',
               headers : zapier_postheaders,

            };

            var zapier_results = '';
            var zapier_request = https.request( zapier_optionspost, function( zapier_res ) {

            zapier_res.on( 'data' , function( d ) {

               zapier_results += d;

            });

            zapier_res.on( 'end' , function( err ) {

               console.log( 'zapier: Zapier WebHooks returned. ' );
               console.log( 'zapier: ' + zapier_results );
               console.log( 'zapier_trigger:' + zapier_results );

               });

            });

            zapier_request.write( zapier_request_object );
            zapier_request.end( );

         }

         callback( null );
         console.log( 'zapier_trigger:===============');
         console.log( "Autolotto OCR Ticket Recognition Ended" );

      },

      function end_call( callback ) {

         console.log( 'In function end call' );
         callback( null );

      }

] ,
   function( err ) {

      if ( err ) {

         console.log( err );

      } else {

         console.log( 'End of autolottoOCRTicket function' );

      }

   } );

}

