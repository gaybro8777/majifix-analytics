import { pkg } from '@lykmapipo/common';
import { head, merge, map, pick, isEmpty, upperFirst, omit, isNumber, compact } from 'lodash';
import { Router } from '@lykmapipo/express-common';
import { getString } from '@lykmapipo/env';
import { model } from '@lykmapipo/mongoose-common';
import parseMs from 'parse-ms';

/**
 * Base aggregation for service requests
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 *
 * @version 0.1.0
 * @since 0.1.0
 */

/* constants */
const METRIC_FLAGS_FIELDS = {
  /**
   * Flag for unconfirmed service request. This shows all service requests
   * which have been reporting via mobileApp, website, USSD and still they
   * are not confirmed yet by an operator.
   *
   * A service request is flagged as unconfirmed service request when it
   * has not been confirmed or resolved yet.
   */
  unconfirmed: {
    $cond: {
      if: { $and: [{ $not: '$resolvedAt' }, { $not: '$confirmedAt' }] },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for new service request. i.e open service request.
   *
   * A service request is flagged as new service request when it
   * has been confirmed but not assigned, attended,completed, verified,
   * approved, reopened or resolved yet.
   */
  new: {
    $cond: {
      if: {
        $and: [
          '$confirmedAt',
          { $not: '$resolvedAt' },
          { $not: '$assignedAt' },
          { $not: '$attendedAt' },
          { $not: '$completedAt' },
          { $not: '$verifiedAt' },
          { $not: '$approvedAt' },
          { $not: '$reopenedAt' },
        ],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for assigned service request. i.e assigned to someone.
   *
   * A service request is flagged as assigned service request when it
   * has been assigned but not attended or resolved yet.
   */
  assigned: {
    $cond: {
      if: {
        $and: [{ $not: '$resolvedAt' }, '$assignedAt', { $not: '$attendedAt' }],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for attended service request. i.e someone is attending the service request.
   *
   * A service request is flagged as attended service request when it
   * has been assigned and attended but not completed or resolved yet.
   */
  attended: {
    $cond: {
      if: {
        $and: [
          { $not: '$resolvedAt' },
          '$assignedAt',
          '$attendedAt',
          { $not: '$completedAt' },
        ],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for completed service request. i.e someone have finished working
   * on the service request.
   *
   * A service request is flagged as completed service request when it
   * has been attended and completed but not verified or resolved yet.
   */
  completed: {
    $cond: {
      if: {
        $and: [
          { $not: '$resolvedAt' },
          '$attendedAt',
          '$completedAt',
          { $not: '$verifiedAt' },
        ],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for verified service request. i.e someone have verified the
   * service request.
   *
   * A service request is flagged as verified service request when it
   * has been completed and verified but not approved or resolved yet.
   */
  verified: {
    $cond: {
      if: {
        $and: [
          { $not: '$resolvedAt' },
          '$completedAt',
          '$verifiedAt',
          { $not: '$approvedAt' },
        ],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for approved service request. i.e someone have approved the
   * service request.
   *
   * A service request is flagged as approved service request when it
   * has been verified and approved but not resolved yet.
   */
  approved: {
    $cond: {
      if: {
        $and: [{ $not: '$resolvedAt' }, '$verifiedAt', '$approvedAt'],
      },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for pending service request i.e service request which is confirmed but
   * not resolved yet
   *
   * A service request is flagged as pending service request when it
   * has been confirmed but not resolved yet.
   */
  pending: {
    $cond: {
      if: { $and: [{ $not: '$resolvedAt' }, '$confirmedAt'] },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for resolved service request i.e service request which is resolved
   *
   * A service request is flagged as resolved service request when it
   * has been resolved.
   */
  resolved: {
    $cond: { if: { $not: '$resolvedAt' }, then: 0, else: 1 },
  },

  /**
   * Flag for reopened service request i.e service request which have been
   * reopened after been resolved
   *
   * A service request is flagged as reopened service request when it
   * has been confirmed and reopened.
   */
  reopened: {
    $cond: {
      if: { $and: ['$reopenedAt', '$confirmedAt'] },
      then: 1,
      else: 0,
    },
  },

  /**
   * Flag for late service request i.e service request passed it's SLA without
   * being resolved
   *
   * Service request is flagged as late service request when it has been either
   * resolved pass it's SLA or not resolved and it's pass it's SLA
   */
  late: {
    $cond: {
      if: {
        $or: [
          {
            $and: [
              { $not: '$resolvedAt' },
              '$expectedAt',
              { $gt: [new Date(), '$expectedAt'] },
            ],
          },
          {
            $and: ['$expectedAt', { $gt: ['$resolvedAt', '$expectedAt'] }],
          },
        ],
      },
      then: 1,
      else: 0,
    },
  },
};
const METRIC_TIMES_FIELDS = {
  /**
   * Time difference between when service request was reported and when it was
   * confirmed by an operator or responsible party.
   *
   * This metric calculate how much time does it take for an organization
   * to confirm/respond to issues which have been reported via channels
   * which doesn't involve operator intervention. i.e USSD, Mobile App, Bot
   * and e.t.c
   */
  confirmTime: { $subtract: ['$confirmedAt', '$createdAt'] },

  /**
   * Time difference between expected time to resolve the service request
   * and current date if not resolved or resolvedAt if resolved pass it SLA.
   *
   * This time will indicate if the service request is late or not base on
   * the SLA(Service Level Agreement) time set per service request nature
   */
  lateTime: {
    $cond: {
      if: { $eq: ['$late', 1] },
      then: {
        $cond: {
          if: '$resolvedAt',
          then: { $subtract: ['$resolvedAt', '$expectedAt'] },
          else: { $subtract: [new Date(), '$expectedAt'] },
        },
      },
      else: null,
    },
  },

  /**
   * This is the time for a confirmed service request to be assigned to
   * a responsible party
   */
  assignTime: { $subtract: ['$assignedAt', '$confirmedAt'] },

  /**
   * This is the time for a assigned service request to be attended
   */
  attendTime: { $subtract: ['$attendedAt', '$assignedAt'] },

  /**
   * This is the time for a attended service request to be completed
   */
  completeTime: { $subtract: ['$completedAt', '$attendedAt'] },

  /**
   * This is the time for a completed service request to be verified
   */
  verifyTime: { $subtract: ['$verifiedAt', '$completedAt'] },

  /**
   * This is the time for a verified service request to be approved
   */
  approveTime: { $subtract: ['$approvedAt', '$verifiedAt'] },

  /**
   * This is the time for an approved service request to be marked as resolved
   */
  resolveTime: { $subtract: ['$resolvedAt', '$createdAt'] },
};

/* fields that can be added service request base aggregation */
const METRIC_FLAGS = 'METRIC_FLAGS';
const METRIC_TIMES = 'METRIC_TIMES';

/**
 * @function
 * @name getBaseAggregation
 * @description Create base aggregation for Service Requests with all fields
 * looked up and un-winded for aggregation operations
 *
 * Also this adds more fields to aid in computation of aggregated data
 *
 * @param {object} criteria Criteria conditions which will be applied in $match
 * @param {string} fields Fields to be added to base aggregation for service requests
 * @returns {object} aggregation instance
 *
 * @version 0.3.0
 * @since 0.1.0
 *
 * @example
 * import getBaseAggregation from './servicerequest.base';
 *
 * // this will give base aggregation with no fields added to it
 * const baseAggregation = getBaseAggregation(criteria);
 *
 * // Base aggregation with metric fields for count
 * const baseAggregation = getBaseAggregation(criteria,'METRIC_FIELDS');
 *
 * // Base aggregation with metric counts fields and metric times
 * // (since metric times depends on metric counts)
 * const baseAggregation = getBaseAggregation(criteria, 'METRIC_TIMES');
 */
const getBaseAggregation = (criteria, fields) => {
  const ServiceRequest = model('ServiceRequest');

  const base = ServiceRequest.lookup(criteria);

  if (fields === METRIC_FLAGS) {
    base.addFields(METRIC_FLAGS_FIELDS);
  }

  if (fields === METRIC_TIMES) {
    base.addFields(METRIC_FLAGS_FIELDS);
    base.addFields(METRIC_TIMES_FIELDS);
  }

  return base;
};

/**
 * @function
 * @name normalizeTime
 * @description Normalize average times which are in milliseconds to a human
 * readable object
 *
 * @param {number} time Time in milliseconds
 * @returns {object} time object that have days,hours,minutes, seconds and e.t.c
 *
 * @version 0.1.0
 * @since 0.2.0
 */
const normalizeTime = time => {
  if (!isNumber(time)) {
    return parseMs(0);
  }

  const averageTime = time >= 0 ? time : -time;

  return parseMs(averageTime);
};

/**
 * @function
 * @name normalizeMetricTimes
 * @description Normalize aggregation object with metric times to a standard
 * format. Also parse those times to human readable format
 *
 * @param {object} data Aggregation result object for a single facet or a single
 * object in a facet which returns an array
 * @returns {object} Object which is has merged data from the aggregration results
 * and parsed metrics times to human readable format
 *
 * @version 0.1.0
 * @since 0.5.0
 */
const normalizeMetricTimes = data => {
  const keys = [
    'confirmTime',
    'assignTime',
    'attendTime',
    'completeTime',
    'verifyTime',
    'approveTime',
    'resolveTime',
    'lateTime',
    'callTime',
  ];

  const times = map(keys, key => ({
    [key]: {
      minimum: normalizeTime(data[`minimum${upperFirst(key)}`]),
      maximum: normalizeTime(data[`maximum${upperFirst(key)}`]),
      average: normalizeTime(data[`average${upperFirst(key)}`]),
    },
  }));

  const strippedObject = omit(data, [
    'maximumAssignTime',
    'minimumAssignTime',
    'averageAssignTime',
    'maximumAttendTime',
    'minimumAttendTime',
    'averageAttendTime',
    'maximumCompleteTime',
    'minimumCompleteTime',
    'averageCompleteTime',
    'maximumVerifyTime',
    'minimumVerifyTime',
    'averageVerifyTime',
    'maximumApproveTime',
    'minimumApproveTime',
    'averageApproveTime',
    'maximumResolveTime',
    'minimumResolveTime',
    'averageResolveTime',
    'maximumLateTime',
    'minimumLateTime',
    'averageLateTime',
    'maximumConfirmTime',
    'minimumConfirmTime',
    'averageConfirmTime',
    'maximumCallTime',
    'minimumCallTime',
    'averageCallTime',
  ]);

  return merge({}, strippedObject, ...times);
};

/**
 * @function
 * @name prepareReportResponse
 * @description Prepare response for Reports by normalizing response shape and average times
 *
 * @param {object} results Aggregation results
 * @returns {object} Normalized response object
 *
 * @version 0.2.0
 * @since 0.2.0
 */
const prepareReportResponse = results => {
  const defaultResults = {
    data: {},
  };

  const data = head(results);

  data.overall = head(data.overall);

  if (data.overall) {
    data.overall = normalizeMetricTimes(data.overall);
  }

  if (data.jurisdictions) {
    data.jurisdictions = map(data.jurisdictions, normalizeMetricTimes);
  }

  if (data.priorities) {
    data.priorities = map(data.priorities, normalizeMetricTimes);
  }

  if (data.services) {
    data.services = map(data.services, normalizeMetricTimes);
  }

  if (data.groups) {
    data.groups = map(data.groups, normalizeMetricTimes);
  }

  if (data.types) {
    data.types = map(data.types, normalizeMetricTimes);
  }

  // if (data.methods) {
  //   data.methods = map(data.methods, normalizeObjectTimes);
  // }

  return { ...defaultResults, data };
};

/**
 * @function
 * @name getFacet
 * @description Get final facet based on selected facet keys
 *
 * @param {object} facet Default facet for a report
 * @param {string[]} facetKeys keys to be in the final facet
 *
 * @returns {object} final facet to be executed
 *
 * @version 0.1.0
 * @since 0.7.0
 */
const getFacet = (facet, facetKeys) => {
  const newFacet = pick(facet, facetKeys);

  if (isEmpty(newFacet)) {
    return facet;
  }

  return newFacet;
};

/* constants */
const METRIC_TIMES$1 = {
  maximumAssignTime: { $max: '$assignTime' },
  minimumAssignTime: { $min: '$assignTime' },
  averageAssignTime: { $avg: '$assignTime' },
  maximumAttendTime: { $max: '$attendTime' },
  minimumAttendTime: { $min: '$attendTime' },
  averageAttendTime: { $avg: '$attendTime' },
  maximumCompleteTime: { $max: '$completeTime' },
  minimumCompleteTime: { $min: '$completeTime' },
  averageCompleteTime: { $avg: '$completeTime' },
  maximumVerifyTime: { $max: '$verifyTime' },
  minimumVerifyTime: { $min: '$verifyTime' },
  averageVerifyTime: { $avg: '$verifyTime' },
  maximumApproveTime: { $max: '$approveTime' },
  minimumApproveTime: { $min: '$approveTime' },
  averageApproveTime: { $avg: '$approveTime' },
  maximumResolveTime: { $max: '$resolveTime' },
  minimumResolveTime: { $min: '$resolveTime' },
  averageResolveTime: { $avg: '$resolveTime' },
  maximumLateTime: { $max: '$lateTime' },
  minimumLateTime: { $min: '$lateTime' },
  averageLateTime: { $avg: '$lateTime' },
  maximumConfirmTime: { $max: '$confirmTime' },
  minimumConfirmTime: { $min: '$confirmTime' },
  averageConfirmTime: { $avg: '$confirmTime' },
  maximumCallTime: { $max: '$call.duration.milliseconds' },
  minimumCallTime: { $min: '$call.duration.milliseconds' },
  averageCallTime: { $avg: '$call.duration.milliseconds' },
};

const METRIC_COUNTS = {
  approved: { $sum: '$approved' },
  assigned: { $sum: 'assigned' },
  attended: { $sum: '$attended' },
  completed: { $sum: '$completed' },
  count: { $sum: 1 },
  late: { $sum: '$late' },
  new: { $sum: '$new' },
  pending: { $sum: '$pending' },
  resolved: { $sum: '$resolved' },
  reopened: { $sum: '$reopened' },
  unconfirmed: { $sum: '$unconfirmed' },
  verified: { $sum: '$verified' },
};

/**
 * @namespace OVERALL_FACET
 * @description Facet for service requests overall general breakdown
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const OVERALL_FACET = {
  overall: [
    {
      $group: {
        _id: null,
        ...METRIC_COUNTS,
        ...METRIC_TIMES$1,
      },
    },
    {
      $project: {
        _id: 0,
      },
    },
  ],
};

/**
 * @namespace PRIORITY_FACET
 * @description Facet for service requests breakdown based on their priorities
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const JURISDICTION_FACET = {
  jurisdictions: [
    {
      $group: {
        _id: '$jurisdiction._id',
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
        late: { $sum: '$late' },
        unconfirmed: { $sum: '$unconfirmed' },
        name: { $first: '$jurisdiction.name' },
        email: { $first: '$jurisdiction.email' },
        phone: { $first: '$jurisdiction.phone' },
        color: { $first: '$jurisdiction.color' },
        count: { $sum: 1 },
        ...METRIC_TIMES$1,
      },
    },
    {
      $sort: {
        name: 1,
      },
    },
  ],
};

/**
 * @namespace STATUS_FACET
 * @description Facet for service requests breakdown based on their statuses
 *
 * @version 0.1.0
 * @since 0.1.0
 */
const STATUS_FACET = {
  statuses: [
    {
      $group: {
        _id: '$status._id',
        name: { $first: '$status.name' },
        color: { $first: '$status.color' },
        weight: { $first: '$status.weight' },
        count: { $sum: 1 },
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
      },
    },
    { $sort: { weight: 1 } },
  ],
};

/**
 * @namespace PRIORITY_FACET
 * @description Facet for service requests breakdown based on their priorities
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const PRIORITY_FACET = {
  priorities: [
    {
      $group: {
        _id: '$group._id',
        name: { $first: '$group.name' },
        color: { $first: '$group.color' },
        weight: { $first: '$group.weight' },
        count: { $sum: 1 },
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
        unconfirmed: { $sum: '$unconfirmed' },
        ...METRIC_TIMES$1,
      },
    },
    {
      $sort: { name: 1 },
    },
  ],
};

/**
 * @namespace SERVICE_FACET
 * @description Facet for service requests breakdown based on their services(nature)
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const SERVICE_FACET = {
  services: [
    {
      $group: {
        _id: '$service._id',
        name: { $first: '$service.name' },
        color: { $first: '$service.color' },
        ...METRIC_COUNTS,
        ...METRIC_TIMES$1,
      },
    },
    {
      $sort: { name: 1 },
    },
  ],
};

/**
 * @namespace SERVICE_GROUP_FACET
 * @description Facet for service requests breakdown based on their service groups
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const SERVICE_GROUP_FACET = {
  groups: [
    {
      $group: {
        _id: '$group._id',
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
        late: { $sum: '$late' },
        unconfirmed: { $sum: '$unconfirmed' },
        name: { $first: '$group.name.en' },
        color: { $first: '$group.color' },
        count: { $sum: 1 },
        ...METRIC_TIMES$1,
      },
    },
    {
      $sort: { name: 1 },
    },
  ],
};

/**
 * @namespace SERVICE_TYPE_FACET
 * @description Facet for service requests breakdown based on their service types
 *
 * @version 0.2.0
 * @since 0.1.0
 */
const SERVICE_TYPE_FACET = {
  types: [
    {
      $group: {
        _id: '$type._id',
        name: { $first: '$type.name' },
        color: { $first: '$type.color' },
        code: { $first: '$type.code' },
        description: { $first: '$type.description' },
        abbreviation: { $first: '$type.abbreviation' },
        count: { $sum: 1 },
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
        unconfirmed: { $sum: '$unconfirmed' },
        late: { $sum: '$late' },
        ...METRIC_TIMES$1,
      },
    },
    {
      $sort: {
        count: -1,
      },
    },
  ],
};

/**
 * @namespace WORKSPACE_FACET
 * @description Facet for service requests breakdown based on workspaces they
 * belong
 *
 * @version 0.1.0
 * @since 0.1.0
 */
const WORKSPACE_FACET = {
  workspaces: [
    {
      $group: {
        _id: '$method.workspace',
        count: { $sum: 1 },
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
      },
    },
    {
      $project: {
        _id: 0,
        name: '$_id',
        count: 1,
        pending: 1,
        resolved: 1,
      },
    },
    { $sort: { count: -1 } },
  ],
};

/**
 * @namespace REPORTING_CHANNEL_FACET
 * @description Facet for service requests breakdown based on their reporting
 * channels i.e call, ussd , web, mobile app, visit e.t.c
 *
 * @version 0.2.1
 * @since 0.1.0
 */
const REPORTING_CHANNEL_FACET = {
  channels: [
    {
      $group: {
        _id: '$method.name',
        count: { $sum: 1 },
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
      },
    },
    {
      $project: {
        name: '$_id',
        count: 1,
        pending: 1,
        resolved: 1,
      },
    },
    { $sort: { count: -1 } },
  ],
};

/**
 * @namespace LEADERSBOARD_FACET
 * @description Facet for operator leader's board
 *
 * @version 0.1.0
 * @since 0.1.0
 */
const OPERATOR_LEADERSBOARD_FACET = {
  operators: [
    {
      $group: {
        _id: '$operator._id',
        pending: { $sum: '$pending' },
        resolved: { $sum: '$resolved' },
        count: { $sum: 1 },
        name: { $first: '$operator.name' },
        email: { $first: '$operator.email' },
        phone: { $first: '$operator.phone' },
        relation: { $first: '$operator.relation' },
      },
    },
    {
      $sort: {
        count: -1,
      },
    },
  ],
};

/**
 * This is overview report based on service request
 * It consist of
 *  - Total service requests per a given period
 *  - Pending service requests
 *  - Resolved service requests
 *  - Service requests breakdown based on their status
 *  - Service requests breakdown based on their priority
 *  - Service requests breakdown based on their nature/service
 *  - Service requests breakdown based on their service group
 *  - Service requests breakdown based on their workspace
 *  - Service requests breakdown based on their type
 *  - Service requests breakdown based on their reporting method
 *  - Service requests breakdown based on their areas/jurisdiction
 *
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 * @version 0.1.0
 * @since 0.1.0
 */

const OVERVIEW_FACET = {
  ...OVERALL_FACET,
  ...JURISDICTION_FACET,
  ...STATUS_FACET,
  ...PRIORITY_FACET,
  ...SERVICE_FACET,
  ...SERVICE_GROUP_FACET,
  ...SERVICE_TYPE_FACET,
  ...WORKSPACE_FACET,
  ...REPORTING_CHANNEL_FACET,
  ...OPERATOR_LEADERSBOARD_FACET,
};

/**
 * @function
 * @name getOverviewReport
 * @description Generate overview report based on provided criteria
 *
 * @param {object} criteria Criteria condition to be applied in $match
 * @param {string[]} facetKeys Contain list of facets key to be used to generate report
 * @param {object} onResults Callback when aggregation operation finishes
 * @returns {object} executed aggregation
 *
 * @version 0.2.0
 * @since 0.1.0
 *
 * @example
 *  getOverviewReport(criteria, function(error, data){
 *    ...
 *  });
 */
const getOverviewReport = (criteria, facetKeys, onResults) => {
  const baseAggregation = getBaseAggregation(criteria, METRIC_TIMES);

  const FACET = getFacet(OVERVIEW_FACET, facetKeys);

  return baseAggregation.facet(FACET).exec(onResults);
};

/**
 * This is performance report based on service request
 * It consist of
 *  - Total service requests per a given period
 *  - Pending service requests
 *  - Resolved service requests
 *  - Service requests breakdown based on their status
 *  - Service requests breakdown based on their priority
 *  - Service requests breakdown based on their nature/service
 *  - Service requests breakdown based on their service group
 *  - Service requests breakdown based on their workspace
 *  - Service requests breakdown based on their type
 *  - Service requests breakdown based on their reporting method
 *
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 * @version 0.1.0
 * @since 0.1.0
 */

const PERFORMANCE_FACET = {
  ...OVERALL_FACET,
  ...STATUS_FACET,
  ...PRIORITY_FACET,
  ...SERVICE_FACET,
  ...SERVICE_GROUP_FACET,
  ...SERVICE_TYPE_FACET,
};

/**
 * @function
 * @name getPerformanceReport
 * @description Generate performance report based on provided criteria
 *
 * @param {object} criteria Criteria condition to be applied in $match
 * @param {string[]} facetKeys Contain list of facets key to be used to generate report
 * @param {object} onResults Callback when aggregation operation finishes
 * @returns {object} executed aggregation
 *
 * @version 0.2.0
 * @since 0.1.0
 *
 * @example
 *  getPerformanceReport(criteria, function(error, data){
 *    ...
 *  });
 */
const getPerformanceReport = (criteria, facetKeys, onResults) => {
  const baseAggregation = getBaseAggregation(criteria, METRIC_TIMES);

  const FACET = getFacet(PERFORMANCE_FACET, facetKeys);

  return baseAggregation.facet(FACET).exec(onResults);
};

/**
 * This is performance report based on service request
 * It consist of
 *  - Total service requests per a given period
 *  - Pending service requests
 *  - Resolved service requests
 *  - Service requests breakdown based on their status
 *  - Service requests breakdown based on their nature/service
 *
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 * @version 0.1.0
 * @since 0.1.0
 */

const OPERATOR_PERFORMANCE_FACET = {
  ...OVERALL_FACET,
  ...SERVICE_FACET,
};

/**
 * @function
 * @name getOperatorPerformanceReport
 * @description Generate operator performance report based on provided criteria
 *
 * @param {object} criteria Criteria condition to be applied in $match
 * @param {string[]} facetKeys Contain list of facets key to be used to generate report
 * @param {object} onResults Callback when aggregation operation finishes
 * @returns {object} executed aggregation
 *
 * @version 0.2.0
 * @since 0.1.0
 *
 * @example
 *  getOperatorPerformanceReport(criteria, function(error, data){
 *    ...
 *  });
 */
const getOperatorPerformanceReport = (criteria, facetKeys, onResults) => {
  const baseAggregation = getBaseAggregation(criteria, METRIC_TIMES);

  const FACET = getFacet(OPERATOR_PERFORMANCE_FACET, facetKeys);

  return baseAggregation.facet(FACET).exec(onResults);
};

/**
 * This is operational report based on service request
 * It consist of
 *  - Total service requests per a given period
 *  - Pending service requests
 *  - Resolved service requests
 *  - Assigned service requests
 *  - In Progress service requests
 *  - Completed service requests
 *  - Verified Service requests
 *  - Approved Service requests
 *  - Service requests breakdown based on their zones
 *  - Service requests breakdown based on their nature/service
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 * @version 0.1.0
 * @since 0.4.3
 */

const OPERATIONAL_FACET = {
  ...OVERALL_FACET,
  ...SERVICE_FACET,
};

/**
 * @function
 * @name getOperationalReport
 * @description Generate operational report based on provided criteria
 *
 * @param {object} criteria Criteria condition to be applied in $match
 * @param {string[]} facetKeys Contain list of facets key to be used to generate report
 * @param {object} onResults Callback when aggregation operation finishes
 * @returns {object} executed aggregation
 *
 * @version 0.2.1
 * @since 0.1.0
 *
 * @example
 *  getOperationalReport(criteria, function(error, data){
 *    ...
 *  });
 */
const getOperationalReport = (criteria, facetKeys, onResults) => {
  const baseAggregation = getBaseAggregation(criteria, METRIC_TIMES);

  const FACET = getFacet(OPERATIONAL_FACET, facetKeys);

  return baseAggregation.facet(FACET).exec(onResults);
};

/**
 * This is standing report based on service request
 *
 * This reports provides count of service requests per jurisdictions,
 * per group, per service, per status and per priority
 *
 * @author Benson Maruchu<benmaruchu@gmail.com>
 * @version 0.1.0
 * @since 0.8.0
 */

/**
 * @function
 * @name getStandingReport
 * @description Generate standing report based on provided criteria
 *
 * @param {object} criteria Criteria condition to be applied in $match
 * @param {object} onResults Callback when aggregation operation finishes
 * @returns {object} executed aggregation
 *
 * @version 0.1.0
 * @since 0.8.0
 *
 * @example
 *  getStandingReport(criteria, function(error, data){
 *    ...
 *  });
 */
const getStandingReport = (criteria, onResults) => {
  const baseAggregation = getBaseAggregation(criteria);

  return baseAggregation
    .group({
      _id: {
        jurisdiction: '$jurisdiction.name',
        group: '$group.name.en',
        service: '$service.name.en',
        status: '$status.name.en',
        priority: '$priority.name.en',
      },
      jurisdiction: { $first: '$jurisdiction' },
      group: { $first: '$group' },
      service: { $first: '$service' },
      status: { $first: '$status' },
      priority: { $first: '$priority' },
      count: { $sum: 1 },
    })
    .project({
      _id: 0,
      count: 1,
      jurisdiction: { name: 1, code: 1, color: 1 },
      group: { name: 1, code: 1, color: 1 },
      service: { name: 1, code: 1, color: 1 },
      status: { name: 1, color: 1, weight: 1 },
      priority: { name: 1, color: 1, weight: 1 },
    })
    .exec(onResults);
};

/* eslint-disable jsdoc/check-tag-names */

/* local constants */
const API_VERSION = getString('API_VERSION', '1.0.0');
const PATH_OVERVIEW = '/reports/overviews';
const PATH_PERFORMANCE = '/reports/performances';
const PATH_OPERATIONAL = '/reports/operations';
const PATH_OPERATOR_PERFORMANCE = '/reports/operators';
const PATH_STANDING = '/reports/standings';

const router = new Router({
  version: API_VERSION,
});

/**
 * @api {get} /reports/overviews Overview Report
 * @apiGroup Analytics
 * @apiName GetOverviews
 * @apiVersion 1.0.0
 * @apiDescription Return overview report
 * @apiUse RequestHeaders
 * @apiUse Overview
 *
 * @apiUse RequestHeaderExample
 * @apiUse OverviewSuccessResponse
 * @apiUse JWTError
 * @apiUse JWTErrorExample
 * @apiUse AuthorizationHeaderError
 * @apiUse AuthorizationHeaderErrorExample
 */
router.get(PATH_OVERVIEW, (request, response, next) => {
  const options = merge({}, request.mquery);

  const filter = options.filter || {};

  const { facets } = request.query;

  let facetKeys = [];

  if (!isEmpty(facets)) {
    facetKeys = compact([].concat(facets.split(',')));
  }

  getOverviewReport(filter, facetKeys, (error, results) => {
    if (error) {
      next(error);
    } else {
      const data = prepareReportResponse(results);
      response.status(200);
      response.json(data);
    }
  });
});

/**
 * @api {get} /reports/performances Area/Jurisdiction performance report
 * @apiGroup Analytics
 * @apiName GetPerformances
 * @apiVersion 1.0.0
 * @apiDescription Return area/jurisdiction performance report
 * @apiUse RequestHeaders
 * @apiUse Performance
 *
 * @apiUse RequestHeaderExample
 * @apiUse OverviewSuccessResponse
 * @apiUse JWTError
 * @apiUse JWTErrorExample
 * @apiUse AuthorizationHeaderError
 * @apiUse AuthorizationHeaderErrorExample
 */
router.get(PATH_PERFORMANCE, (request, response, next) => {
  const options = merge({}, request.mquery);

  const filter = options.filter || {};

  const { facets } = request.query;

  let facetKeys = [];

  if (!isEmpty(facets)) {
    facetKeys = compact([].concat(facets.split(',')));
  }

  getPerformanceReport(filter, facetKeys, (error, results) => {
    if (error) {
      next(error);
    } else {
      const data = prepareReportResponse(results);
      response.status(200);
      response.json(data);
    }
  });
});

// TODO update api doc here

/**
 * @api {get} /reports/operators Overview Report
 * @apiGroup Analytics
 * @apiName GetOperators
 * @apiVersion 1.0.0
 * @apiDescription Return overview report
 * @apiUse RequestHeaders
 * @apiUse Operator
 *
 * @apiUse RequestHeaderExample
 * @apiUse OverviewSuccessResponse
 * @apiUse JWTError
 * @apiUse JWTErrorExample
 * @apiUse AuthorizationHeaderError
 * @apiUse AuthorizationHeaderErrorExample
 */
router.get(PATH_OPERATOR_PERFORMANCE, (request, response, next) => {
  const options = merge({}, request.mquery);

  const filter = options.filter || {};

  const { facets } = request.query;

  let facetKeys = [];

  if (!isEmpty(facets)) {
    facetKeys = compact([].concat(facets.split(',')));
  }

  getOperatorPerformanceReport(filter, facetKeys, (error, results) => {
    if (error) {
      next(error);
    } else {
      const data = prepareReportResponse(results);
      response.status(200);
      response.json(data);
    }
  });
});

/**
 * @api {get} /reports/operations Operational Report
 * @apiGroup Analytics
 * @apiName GetOperations
 * @apiVersion 1.0.0
 * @apiDescription Return overview report
 * @apiUse RequestHeaders
 * @apiUse Operator
 *
 * @apiUse RequestHeaderExample
 * @apiUse OverviewSuccessResponse
 * @apiUse JWTError
 * @apiUse JWTErrorExample
 * @apiUse AuthorizationHeaderError
 * @apiUse AuthorizationHeaderErrorExample
 */
router.get(PATH_OPERATIONAL, (request, response, next) => {
  const options = merge({}, request.mquery);

  const filter = options.filter || {};

  const { facets } = request.query;

  let facetKeys = [];

  if (!isEmpty(facets)) {
    facetKeys = compact([].concat(facets.split(',')));
  }

  getOperationalReport(filter, facetKeys, (error, results) => {
    if (error) {
      next(error);
    } else {
      const data = prepareReportResponse(results);
      response.status(200);
      response.json(data);
    }
  });
});

/**
 * @api {get} /reports/standing Operational Report
 * @apiGroup Analytics
 * @apiName GetStanding
 * @apiVersion 1.0.0
 * @apiDescription Return overview report
 * @apiUse RequestHeaders
 * @apiUse Operator
 *
 * @apiUse RequestHeaderExample
 * @apiUse OverviewSuccessResponse
 * @apiUse JWTError
 * @apiUse JWTErrorExample
 * @apiUse AuthorizationHeaderError
 * @apiUse AuthorizationHeaderErrorExample
 */
router.get(PATH_STANDING, (request, response, next) => {
  const options = merge({}, request.mquery);

  const filter = options.filter || {};

  getStandingReport(filter, (error, results) => {
    if (error) {
      next(error);
    } else {
      const data = { data: results };
      response.status(200);
      response.json(data);
    }
  });
});

/**
 * @name majifix-analytics
 * @description A module for analytics and visualizations of majifix data
 *
 * @author Benson Maruchu <benmaruchu@gmail.com>
 * @author lally elias <lallyelias87@gmail.com>
 * @since  0.1.0
 * @version 0.2.0
 * @license MIT
 * @example
 *
 * const { app } = require('@codetanzania/majifix-analytics');
 *
 * ...
 *
 * app.start();
 */

const info = pkg(
  `${__dirname}/package.json`,
  'name',
  'description',
  'version',
  'license',
  'homepage',
  'repository',
  'bugs',
  'sandbox',
  'contributors'
);

// extract api version
const apiVersion = router.version;

export { router as analyticRouter, apiVersion, info };
