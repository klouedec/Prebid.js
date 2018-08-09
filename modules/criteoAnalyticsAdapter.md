# Overview

Module Name: Criteo Analytics Adapter
Module Type: Analytics Adapter
Maintainer: pi-direct@criteo.com

# Description

Analytics adapter for criteo.com. Contact pi-direct@criteo.com for information.

# Bundling
```
    // Additionnal adapters can be added to the command line
    gulp build && gulp bundle --modules=criteoBidAdapter,criteoAnalyticsAdapter
```

# Integration
```
    pbjs.que.push(function() {
        pbjs.enableAnalytics([{
            provider: 'criteo',
            options: {
                samplingPercentage: 100,
                sendDelay: 3000
            }
        }]);
    });
```