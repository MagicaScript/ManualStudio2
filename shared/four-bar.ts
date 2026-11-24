import { Quaternion, Vector3 } from 'three';
import { rotationDelta, type RigidDelta, type WorldAxis } from './assembly-motion.ts';
import type { FourBarMotion } from './types.ts';

const fullTurn = 2 * Math.PI;
const signedAngle = (from: Vector3, to: Vector3, normal: Vector3): number => Math.atan2(normal.dot(from.clone().cross(to)), from.dot(to));

function containsAngle(start: number, end: number, angle: number): boolean {
  const low = Math.min(start, end), high = Math.max(start, end);
  return Math.ceil((low - angle) / fullTurn) <= Math.floor((high - angle) / fullTurn);
}

export function prepareFourBar(inputAxis: WorldAxis, outputAxis: WorldAxis, inputJoint: Vector3, outputJoint: Vector3,
  span: number, selectedBranch?: FourBarMotion['branch']) {
  const direction = outputAxis.direction;
  if (direction.clone().cross(inputAxis.direction).length() > 1e-7) throw new Error('Four-bar input and output axes must be parallel.');
  const pivotAtJoint = (axis: WorldAxis, joint: Vector3) => axis.origin.clone().addScaledVector(direction, joint.clone().sub(axis.origin).dot(direction));
  const inputPivot = pivotAtJoint(inputAxis, inputJoint), outputPivot = pivotAtJoint(outputAxis, outputJoint);
  const ground = outputPivot.clone().sub(inputPivot).projectOnPlane(direction);
  const inputArm = inputJoint.clone().sub(inputPivot).projectOnPlane(direction);
  const outputArm = outputJoint.clone().sub(outputPivot).projectOnPlane(direction);
  const rod = outputJoint.clone().sub(inputJoint).projectOnPlane(direction);
  const groundLength = ground.length(), inputRadius = inputArm.length(), outputRadius = outputArm.length(), rodLength = rod.length();
  const tolerance = Math.max(1e-9, Math.max(groundLength, inputRadius, outputRadius, rodLength) * 1e-10);
  if ([groundLength, inputRadius, outputRadius, rodLength].some(length => !Number.isFinite(length) || length <= tolerance)) {
    throw new Error('A four-bar needs distinct axes, nonzero arms and a nonzero projected coupler length.');
  }

  const center = (angle: number) => outputArm.clone().applyAxisAngle(direction, angle).add(ground);
  const initialCenter = center(0), finalDistance = center(span).length(), initialDistance = initialCenter.length();
  const phase = signedAngle(ground, outputArm, direction);
  // The distance between the circle centers reaches its extrema when the output arm and ground link are collinear.
  const minDistance = containsAngle(phase, phase + span, Math.PI) ? Math.abs(groundLength - outputRadius) : Math.min(initialDistance, finalDistance);
  const maxDistance = containsAngle(phase, phase + span, 0) ? groundLength + outputRadius : Math.max(initialDistance, finalDistance);
  const inner = Math.abs(inputRadius - rodLength), outer = inputRadius + rodLength;
  if (minDistance <= tolerance) throw new Error('The four-bar sweep reaches coincident circle centers, where the input hinge is undetermined.');
  if (minDistance < inner - tolerance || maxDistance > outer + tolerance) {
    throw new Error('The output sweep is unreachable with the four-bar lengths derived from the preceding keyframe.');
  }

  const startSide = direction.dot(initialCenter.clone().cross(inputArm)) / initialDistance;
  const initialBranch = Math.abs(startSide) <= tolerance ? undefined : startSide > 0 ? 'positive' : 'negative';
  if (initialBranch && selectedBranch && selectedBranch !== initialBranch) throw new Error('The chosen four-bar branch disagrees with the preceding keyframe.');
  const branch = initialBranch ?? selectedBranch;
  if (!branch) throw new Error('The four-bar starts at a dead center. Set branch to positive or negative.');
  const branchSign = branch === 'positive' ? 1 : -1;

  const jointsAt = (angle: number) => {
    if (angle === 0) return { input: inputJoint, output: outputJoint };
    const axisToOutput = center(angle), distance = axisToOutput.length(), toward = axisToOutput.divideScalar(distance);
    const along = (distance + (inputRadius - rodLength) * (inputRadius + rodLength) / distance) / 2;
    const height = Math.sqrt(Math.max(0, (outer - distance) * (outer + distance))
      * Math.max(0, (distance - inner) * (distance + inner))) / (2 * distance);
    const input = inputPivot.clone().addScaledVector(toward, along).addScaledVector(direction.clone().cross(toward), height * branchSign);
    const output = outputArm.clone().applyAxisAngle(direction, angle).add(outputPivot);
    return { input, output };
  };
  const deltasAt = (angle: number): [RigidDelta, RigidDelta, RigidDelta] => {
    const hinges = jointsAt(angle);
    const inputAngle = signedAngle(inputArm, hinges.input.clone().sub(inputPivot), direction);
    const rodAngle = signedAngle(rod, hinges.output.clone().sub(hinges.input).projectOnPlane(direction), direction);
    const rotation = new Quaternion().setFromAxisAngle(direction, rodAngle);
    const coupler = { rotation, translation: hinges.input.clone().sub(inputJoint.clone().applyQuaternion(rotation)) };
    return [rotationDelta({ origin: inputPivot, direction }, inputAngle), rotationDelta({ origin: outputPivot, direction }, angle), coupler];
  };
  return { inputPivot, inputJoint, outputJoint, branch, jointsAt, deltasAt };
}
